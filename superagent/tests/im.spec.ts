import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Executor, type Assessor, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { bridgeDirOf, imKind, imTrigger, pollInbox, publishBridge, readInbox, sendIm } from '../src/sources/im.ts'
import type { ImConfig } from '../src/sources/im.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'

const relays = (dir: string, lines: unknown[]) => writeFileSync(join(dir, 'inbox.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
const relay = (over: Record<string, unknown> = {}) => ({ id: 'm1', platform: 'telegram', chatId: 'chat1', chatType: 'group',
  userId: 'alice', userName: 'Alice', text: 'build the report', mentioned: true, at: '2026-11-03T10:00:00.000Z', ...over })

describe('the IM bridge kind', () => {
  const dirs: string[] = []
  const stores: { close(): void }[] = []
  const dir = () => { const made = mkdtempSync(join(tmpdir(), 'im-bridge-')); dirs.push(made); return made }
  afterEach(() => {
    for (const store of stores) { try { store.close() } catch { /* already closed */ } }
    stores.length = 0
    for (const made of dirs) rmSync(made, { recursive: true, force: true })
    dirs.length = 0
    publishBridge('')
  })

  it('translates a relayed message: stable id, thread, actor, addressing, and nothing for blank text', () => {
    const trigger = imTrigger(relay())!
    expect(trigger.id).toBe(key('im', 'm1'))
    expect(trigger.threads[0]).toEqual({ source: 'im', id: 'telegram:chat1' })
    expect(trigger.actor).toEqual({ source: 'im', id: 'telegram:alice' })
    expect(trigger.addressed).toBe('mention')
    expect(trigger.human).toBe(true)
    expect(imTrigger(relay({ chatType: 'private' }))!.addressed).toBe('direct')
    expect(imTrigger(relay({ mentioned: false }))!.addressed).toBeUndefined()
    expect(imTrigger(relay({ text: '  ' }))).toBeUndefined()
  })

  function host(overrides: Partial<SourceContextDeps> = {}, configOver: Record<string, unknown> = {}) {
    const bridge = dir()
    const settings = SettingsSchema.parse({ eval: { mode: 'auto' },
      sources: { im: { enabled: true, config: { bridgeDir: bridge, pollSeconds: 2, ...configOver } } },
      policy: { sources: { im: { allowed: [{ id: 'telegram:alice', name: 'Alice' }] } } } })
    const storeDir = mkdtempSync(join(tmpdir(), 'im-store-'))
    dirs.push(storeDir)
    const store = new Store(join(storeDir, 'db.sqlite'))
    stores.push(store)
    store.saveSettings(settings)
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(imKind)
    const deployment = testDeployment()
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
    const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
      deployment, ready: Promise.resolve(), configured: () => true, receive, ...overrides }
    const context = sourceContextOf(parts, imKind)
    // The settings parse enables the im instance, so its block exists.
    const config = settings.sources.im!.config as ImConfig
    return { ...parts, ...context, ctx: context, health: board.all, store, engine, bridge, config, receive }
  }

  it('takes in the inbox once and moves the cursor, and rereading is a duplicate', async () => {
    const h = host()
    await relays(h.bridge, [relay(), { broken: true }, relay({ id: 'm2', text: 'and this' })])
    expect(await pollInbox(h.ctx, h.config, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(h.ctx.state.get(KV.im.cursor)).toBeGreaterThan(0)
    expect(h.engine.candidate(key('im', 'm1'))?.strength).toBe('explicit')
    // The writer replayed the same lines (rotation); stable ids make rereading safe.
    h.ctx.state.set(KV.im.cursor, 0)
    await pollInbox(h.ctx, h.config, new AbortController().signal)
    expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
    expect(h.receive).toHaveBeenCalledTimes(4)
  })

  it('restarts from zero when the file shrank, and replay stays a duplicate', async () => {
    const h = host()
    await relays(h.bridge, [relay()])
    await pollInbox(h.ctx, h.config, new AbortController().signal)
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    // The writer rotated the file; the new content is shorter than the cursor.
    await relays(h.bridge, [relay({ text: 'again' })])
    await pollInbox(h.ctx, h.config, new AbortController().signal)
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
    expect(h.receive).toHaveBeenCalledTimes(2)
  })

  it('reads only complete lines and keeps a partial tail unread', async () => {
    const made = dir()
    appendFileSync(join(made, 'inbox.jsonl'), `${JSON.stringify(relay())}\n${JSON.stringify(relay({ id: 'm2' }))}`)
    const first = await readInbox(join(made, 'inbox.jsonl'), 0)
    expect(first.lines).toEqual([JSON.stringify(relay())])
    appendFileSync(join(made, 'inbox.jsonl'), '\n')
    const second = await readInbox(join(made, 'inbox.jsonl'), first.next)
    expect(second.lines).toEqual([JSON.stringify(relay({ id: 'm2' }))])
    expect(second.next).toBeGreaterThan(first.next)
  })

  it('queues replies in the outbox for the pump and refuses a missing target', async () => {
    const made = dir()
    publishBridge(made)
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const channel = { source: 'im', thread: 'im:telegram:chat1', address: { platform: 'telegram', chatId: 'chat1' } }
    expect(await sendIm({ commands }, { id: 'out-1', channel, text: 'done', kind: 'reply' })).toBe('sent')
    const lines = readFileSync(join(made, 'outbox.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]!)).toEqual({ id: 'out-1', platform: 'telegram', chatId: 'chat1', text: 'done' })
    await expect(sendIm({ commands }, { id: 'out-2', channel: { ...channel, address: {} }, text: 'x', kind: 'reply' })).rejects.toThrow('target')
  })

  it('leaves the cursor in the state store under the registered key', async () => {
    const h = host()
    await relays(h.bridge, [relay()])
    await pollInbox(h.ctx, h.config, new AbortController().signal)
    expect(h.store.get(KV.im.cursor)).toBe(h.ctx.state.get(KV.im.cursor))
  })
})
