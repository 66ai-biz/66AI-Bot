/** IM bridge source kind: 66AI Bot relays its IM channel messages into a file queue under the data dir; this kind turns them
 * into Triggers and queues replies for 66AI Bot's outbox pump, which delivers them through the channel's platform adapter.
 *
 * Bridge layout (`<DSH_HOME>/im-bridge` by default, override with the Source's `bridgeDir`):
 * - `inbox.jsonl`: one JSON object per relayed inbound message, written by 66AI Bot:
 *   `{ id, platform, chatId, chatType?, userId, userName?, text, mentioned, at }`.
 * - `outbox.jsonl`: one JSON object per reply, written here and delivered by 66AI Bot: `{ id, platform, chatId, text }`.
 * Both files are append-only; each side tracks its read position by byte offset and treats a shrunken file (the writer's
 * rotation) as a restart from zero — stable message IDs make replaying safe.
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { isoTime, key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'im'

const ConfigSchema = z.object({
  /** The bridge directory; empty uses `<DSH_HOME>/im-bridge`. */
  bridgeDir: z.string().trim().max(500).default(''),
  pollSeconds: z.number().int().min(2).max(3600).default(10),
}).strict()
export type ImConfig = z.infer<typeof ConfigSchema>

/** One relayed message as 66AI Bot writes it. */
const RelaySchema = z.looseObject({
  id: z.string().min(1), platform: z.string().min(1), chatId: z.string().min(1), chatType: z.string().optional(),
  userId: z.string().min(1), userName: z.string().optional(), text: z.string(), mentioned: z.boolean().default(false), at: z.string(),
})
export type RelayMessage = z.infer<typeof RelaySchema>

/** The bridge directory for the given config; empty names `<DSH_HOME>/im-bridge` (the app always sets DSH_HOME). */
export const bridgeDirOf = (config: Pick<ImConfig, 'bridgeDir'>): string =>
  config.bridgeDir !== '' ? config.bridgeDir : join(process.env.DSH_HOME ?? '.', 'im-bridge')

// The registry hands `channel.send` only the commands, so the loop publishes the resolved bridge directory here; `send`
// falls back to the default location before the first round, which is where the default configuration points anyway.
let bridge = ''
/** Publishes the resolved bridge directory for `sendIm`; the polling loop keeps it current. */
export const publishBridge = (dir: string): void => { bridge = dir }
const outboxPath = (config: Pick<ImConfig, 'bridgeDir'>): string => join(bridge || bridgeDirOf(config), 'outbox.jsonl')

/** The Trigger of one relayed message; blank text relays nothing. */
export function imTrigger(message: RelayMessage): Trigger | undefined {
  if (message.text.trim() === '') return undefined
  const thread = `${message.platform}:${message.chatId}`
  return {
    id: key(SOURCE, message.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: `${message.platform}:${message.userId}` },
    human: true,
    ...(message.chatType === 'private' ? { addressed: 'direct' as const }
      : message.mentioned ? { addressed: 'mention' as const } : {}),
    at: isoTime(message.at),
    text: message.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { platform: message.platform, chatId: message.chatId } },
    meta: { platform: message.platform, chatId: message.chatId, chatType: message.chatType ?? '', userId: message.userId,
      userName: message.userName ?? '', messageId: message.id },
  }
}

/** The complete lines after `offset`, and the offset of the first unread byte. A shrunken file restarts from zero. */
export async function readInbox(path: string, offset: number): Promise<{ lines: string[]; next: number }> {
  if (!existsSync(path)) return { lines: [], next: 0 }
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    if (size < offset) offset = 0
    const remaining = Math.min(size - offset, 16 * 1024 * 1024)
    if (remaining <= 0) return { lines: [], next: offset }
    const buffer = Buffer.alloc(remaining)
    const { bytesRead } = await handle.read(buffer, 0, remaining, offset)
    const text = buffer.toString('utf8', 0, bytesRead)
    const cut = text.lastIndexOf('\n')
    if (cut === -1) return { lines: [], next: offset }
    const complete = text.slice(0, cut + 1)
    // Everything before the last newline is well-formed UTF-8 (a newline byte never occurs inside a character), so its
    // byte length is exact and the partial tail character stays unread.
    return { lines: complete.split('\n').filter(line => line !== ''), next: offset + Buffer.byteLength(complete, 'utf8') }
  } finally { await handle.close() }
}

/** Read the bridge after the cursor, take in each message, then move the cursor past them. */
export async function pollInbox(ctx: SourceContext, config: ImConfig, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const inbox = join(bridgeDirOf(config), 'inbox.jsonl')
  const { lines, next } = await readInbox(inbox, ctx.state.get(KV.im.cursor) ?? 0)
  if (lines.length === 0) return { read: 0, unreadable: 0 }
  let unreadable = 0
  for (const line of lines) {
    if (signal.aborted) throw new Error('The IM Source stopped during the read')
    const parsed = RelaySchema.safeParse(JSON.parse(line))
    if (!parsed.success) { unreadable++; continue }
    const trigger = imTrigger(parsed.data)
    if (trigger === undefined) continue
    await ctx.receive(trigger)
    const chat = { label: { zh: '对话', en: 'Conversation' }, value: `${parsed.data.platform}:${parsed.data.chatId}` }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { chat } })
  }
  ctx.state.set(KV.im.cursor, next)
  return { read: lines.length, unreadable }
}

/** Queue a reply for 66AI Bot's outbox pump; delivery is its job, so the write is the send. */
export async function sendIm(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  void host
  const { platform, chatId } = message.channel.address
  if (!platform || !chatId) throw new Error('Missing IM reply target')
  const outbox = outboxPath({ bridgeDir: '' })
  await mkdir(dirname(outbox), { recursive: true })
  // Rotate the outbox once it grows past the cap; the pump treats a shrunken file as a restart from zero, and
  // deduplicates the replayed lines by message ID.
  try {
    if ((await stat(outbox)).size > 10 * 1024 * 1024) {
      await rename(outbox, `${outbox}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
      const rotated = (await readdir(dirname(outbox))).filter(name => name.startsWith('outbox.jsonl.')).sort()
      for (const name of rotated.slice(0, Math.max(0, rotated.length - 2))) await rm(join(dirname(outbox), name))
    }
  } catch { /* a missing outbox has nothing to rotate */ }
  // The pump deduplicates by message ID, so an accidental replay of this line sends nothing twice.
  await appendFile(outbox, `${JSON.stringify({ id: message.id, platform, chatId, text: message.text })}\n`, 'utf8')
  return 'sent'
}

const zh = (text: string) => ({ zh: text, en: text } as const)
export const imKind: SourceKind<ImConfig> = {
  kind: SOURCE,
  title: { zh: 'IM 桥接', en: 'IM bridge' },
  description: { zh: '接收 66AI Bot 工单模式渠道转发的消息；回复经其通道适配器送达。', en: 'Receives the messages 66AI Bot channels relay in work mode; replies go out through their channel adapters.' },
  schema: ConfigSchema,
  fields: [
    { key: 'bridgeDir', type: 'text', advanced: true, label: { zh: '桥接目录', en: 'Bridge directory' },
      hint: { zh: '留空用数据目录下的 im-bridge。', en: 'Leave empty for im-bridge under the data dir.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['im'],
  // The relay switch of each 66AI Bot channel is the listening gate; the Policy decides whose messages may originate work.
  scope: () => ({ listened: true, observed: true }),
  channel: {
    send: sendIm,
    link: address => ({ url: '', label: zh(`IM 对话 ${address.platform}:${address.chatId}`) }),
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/\b[0-9a-f-]{36}\b/g) ?? [])] }),
  policy: {
    unnamed: { person: { zh: 'IM 用户', en: 'IM user' }, bot: { zh: 'IM 机器人', en: 'IM bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine(list => new Set(list.map(entry => entry.id)).size === list.length, 'Duplicate sender IDs').default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '发送者（平台:用户ID）', en: 'Sender (platform:userId)' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单内的人在消息里 @ 机器人，或私聊机器人。', en: 'Someone on the list mentions the agent in a message, or messages it directly.' },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_IM_CHAT', description: { zh: '接下工单的 IM 对话（平台:对话ID）；工单不是从 IM 桥接来的时为空',
      en: 'The IM conversation that started the ticket (platform:chatId); empty when the ticket did not start on the IM bridge' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_IM_CHAT: trigger?.source === SOURCE
      ? `${String(trigger.meta.platform ?? '')}:${String(trigger.meta.chatId ?? '')}` : '' }),
  },
}

export const name = 'dsh-superagent-im'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(imKind), 'im: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, imKind)
    const controller = new AbortController()
    // This kind needs no repository or account, so unlike the other Sources it polls before setup resolves; a restart of
    // dsh-superagent during setup simply aborts and restarts the loop.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<ImConfig>(SOURCE)
    if (config === undefined) {
      ctx.report(SOURCE, { state: 'paused', detail: 'Off' })
      bridge = ''
    } else {
      const dir = bridgeDirOf(config)
      publishBridge(dir)
      if (!existsSync(join(dir, 'inbox.jsonl'))) {
        ctx.report(SOURCE, { state: 'paused', detail: 'No relayed channel yet: turn on work mode on a 66AI Bot IM channel' })
      } else {
        const at = new Date().toISOString()
        try {
          const { read, unreadable } = await pollInbox(ctx, config, signal)
          failures = 0
          ctx.report(SOURCE, { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
        } catch (error) {
          failures += 1
          if (!signal.aborted && failures >= 3) {
            ctx.report(SOURCE, { state: 'error', detail: `${failures} consecutive failed polls; last: ${String(error)}` })
          }
        }
      }
    }
    await delay((config?.pollSeconds ?? 10) * 1000, undefined, { signal }).catch(() => {})
  }
}
