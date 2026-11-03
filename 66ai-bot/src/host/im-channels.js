// IM channels: put each Bot on Telegram, Discord, Feishu or DingTalk, all
// outbound-only long connections (no public callback URL needed). An inbound IM
// message is delivered to the channel's Bot like a user message that names its
// origin; the turn's texts are sent back to the chat that asked. MuseBot's
// multi-platform reach on this App's own runtime, with the settings in the App.
// A channel in work mode (relay) does not chat: its messages go over the file
// bridge at <DSH_HOME>/im-bridge to the dsh-superagent IM Source, whose replies
// this module pumps back out through the same adapters.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { textOf } from './text.js'

const MAX_TITLE = 60
const REPLY_TIMEOUT_MS = 10 * 60_000
const BRIDGE_ROTATE_BYTES = 10 * 1024 * 1024
const BRIDGE_ROTATE_KEEP = 2
const OUTBOX_SENT_KEEP = 2000
const PLATFORMS = {
  telegram: { name: 'Telegram', fields: ['token', 'proxy'], hint: 'Bot token from @BotFather' },
  discord: { name: 'Discord', fields: ['token', 'proxy'], hint: 'Bot token from the developer portal' },
  feishu: { name: 'Feishu', fields: ['appId', 'appSecret'], hint: 'App ID and secret, long connection mode' },
  dingtalk: { name: 'DingTalk', fields: ['clientId', 'clientSecret'], hint: 'Stream-mode app credentials' },
}

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const mask = secret => typeof secret === 'string' && secret.length > 8 ? `••••${secret.slice(-4)}` : (secret ? '••••' : '')

// One inbound message from a platform adapter.
// { chatId, chatType: 'private'|'group', userId, userName, text, mentioned }
export function install(rt) {
  const { ctx, state } = rt
  state.imChannels ??= {}
  state.imOutbox ??= { cursor: 0, sent: [] }

  // channelId -> { stop(signal) }; started only while the channel is enabled.
  const running = new Map()
  // sessionId -> [{ resolve, texts, timer }]; the turn's texts go to the oldest asker.
  const waiting = new Map()

  const adapters = () => rt.imAdapters ?? {}

  const botOfChannel = channel => rt.botOf(channel.botId)
  const sessionOf = channel => {
    const bot = botOfChannel(channel)
    if (bot === undefined) throw invalid('The channel\'s Bot is gone')
    return rt.chatOf(bot.id)
  }

  // The file bridge the dsh-superagent IM Source reads and writes.
  const bridgeDir = () => rt.config.imBridgeDir ?? join(rt.dshHome, 'im-bridge')

  // Rotate a bridge file once it grows past the cap, keeping a few generations.
  const rotateIfBig = (file, stem) => {
    try {
      if (statSync(file).size < BRIDGE_ROTATE_BYTES) return
      renameSync(file, `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
      const rotated = readdirSync(dirname(file)).filter(name => name.startsWith(`${stem}.jsonl.`)).sort()
      for (const name of rotated.slice(0, Math.max(0, rotated.length - BRIDGE_ROTATE_KEEP))) {
        unlinkSync(join(dirname(file), name))
      }
    } catch { /* a missing file has nothing to rotate */ }
  }

  // Work mode: hand the message to the Superagent over the bridge inbox. Stable
  // random ids make the Source's cursor and duplicate handling safe; the reader
  // treats a shrunken file (this rotation) as a restart from zero.
  const relayInbound = (channel, message) => {
    const dir = bridgeDir()
    mkdirSync(dir, { recursive: true })
    const inbox = join(dir, 'inbox.jsonl')
    rotateIfBig(inbox, 'inbox')
    const line = JSON.stringify({
      id: randomUUID(), platform: channel.platform, chatId: String(message.chatId), chatType: message.chatType,
      userId: String(message.userId), userName: message.userName ?? '', text: message.text,
      mentioned: message.mentioned === true, at: new Date().toISOString(),
    })
    appendFileSync(inbox, `${line}\n`, 'utf8')
    channel.stats.relayed = (channel.stats.relayed ?? 0) + 1
  }

  // The turn's reply for one inbound message. Bots answer one channel question at
  // a time, in arrival order, so a busy Bot queues the next chat instead of
  // steering a turn that would mix answers.
  const chains = new Map()
  const chained = (botId, run) => {
    const last = chains.get(botId) ?? Promise.resolve()
    const next = last.catch(() => {}).then(run)
    chains.set(botId, next)
    void next.catch(() => {}).then(() => { if (chains.get(botId) === next) chains.delete(botId) })
    return next
  }

  // Each asker waits on its own clock; only the oldest one reads the turn's texts.
  const waitForTurn = (sessionId) => {
    const entry = { resolve: null, texts: [], finish: null }
    const done = new Promise(resolve => { entry.resolve = resolve })
    const finish = value => {
      clearTimeout(entry.timer)
      const list = waiting.get(sessionId) ?? []
      const at = list.indexOf(entry)
      if (at !== -1) list.splice(at, 1)
      if (list.length === 0) waiting.delete(sessionId)
      entry.resolve(value)
    }
    entry.finish = finish
    entry.timer = setTimeout(() => finish({ timeout: true }), REPLY_TIMEOUT_MS)
    const list = waiting.get(sessionId) ?? []
    list.push(entry)
    waiting.set(sessionId, list)
    return done
  }

  // The App's user turns run without a source; channel turns are told apart by
  // their leading marker line, which is also what the model reads first.
  async function onInbound(channel, message) {
    const stats = channel.stats ??= { received: 0, sent: 0, lastAt: 0, error: null }
    stats.received += 1
    stats.lastAt = Date.now()
    stats.error = null
    void rt.save().catch(() => {})
    const allow = channel.allowFrom ?? []
    if (allow.length > 0 && !allow.includes(message.chatId) && !allow.includes(message.userId)) return
    if (message.chatType === 'group' && channel.trigger === 'mention' && message.mentioned !== true) return
    if (channel.relay === true) {
      // Work mode: the Superagent owns this conversation; no chat turn.
      try { relayInbound(channel, message); stats.error = null } catch (error) { stats.error = String(error).slice(0, 300) }
      void rt.save().catch(() => {})
      return
    }
    const bot = botOfChannel(channel)
    if (bot === undefined) return
    const sessionId = rt.chatOf(bot.id)
    const who = message.userName?.trim() || message.userId || 'someone'
    const where = message.chatType === 'group' ? `group ${message.chatId}` : 'private chat'
    const text = `[Message from ${who} on ${PLATFORMS[channel.platform]?.name ?? channel.platform} (${where})]\n${message.text}`
    const reply = await chained(bot.id, async () => {
      await rt.load()
      const done = waitForTurn(sessionId)
      try {
        await rt.ensureCapabilities(sessionId)
        await ctx.sessionController.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, AbortSignal.timeout(30_000))
      } catch (error) {
        return { error: `Delivery failed: ${error?.message ?? error}`.slice(0, 300) }
      }
      return await done
    })
    stats.sent += 1
    void rt.save().catch(() => {})
    const out = reply?.error ?? (reply?.timeout ? 'I am still working on it — the reply will take a while longer.' : reply?.texts)
    if (typeof out === 'string' && out.trim() !== '') await adapters()[channel.platform]?.send(channel, message.chatId, out)
  }

  // Session events drive the waiters, like groups' round waiters but simpler:
  // the texts of the turn belong to whoever asked first for this Session.
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    const list = id === undefined ? undefined : waiting.get(id)
    if (list === undefined || list.length === 0) return
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') list[0].texts.push(text)
    } else if (event.type === 'turn/end') {
      const entry = list[0]
      const texts = entry.texts.join('\n\n').trim()
      entry.texts = []
      entry.finish({ texts })
    }
  })

  // A fresh part takes over the waiting list: the old Session's turn died with it.
  const rebindWaiters = (fromId, toId) => {
    const list = waiting.get(fromId)
    if (list === undefined) return
    waiting.delete(fromId)
    waiting.set(toId, [...(waiting.get(toId) ?? []), ...list])
  }

  // The outbox pump: the Superagent's IM Source queues reply lines
  // `{ id, platform, chatId, text }` and this sends each exactly once through the
  // channel's adapter. The cursor advances only past delivered or permanently
  // undeliverable lines; a failing or stopped destination holds the rest back.
  // Sent ids stay in the state file, so a restart never sends a line twice.
  let pumping = false
  const outboxTick = async () => {
    if (pumping) return
    pumping = true
    try {
      const mark = state.imOutbox ??= { cursor: 0, sent: [] }
      let bytes
      try { bytes = readFileSync(join(bridgeDir(), 'outbox.jsonl')) } catch { return }
      if (bytes.length < mark.cursor) mark.cursor = 0
      const chunk = bytes.subarray(mark.cursor).toString('utf8')
      const cut = chunk.lastIndexOf('\n')
      if (cut === -1) return
      const complete = chunk.slice(0, cut + 1)
      const end = mark.cursor + Buffer.byteLength(complete, 'utf8')
      let stop = null
      let offset = mark.cursor
      let changed = false
      for (const line of complete.split('\n')) {
        const at = offset
        offset += Buffer.byteLength(`${line}\n`, 'utf8')
        if (line.trim() === '') continue
        let reply
        try { reply = JSON.parse(line) } catch { changed = true; continue }
        if (mark.sent.includes(reply.id)) continue
        const channel = Object.values(state.imChannels).find(item => item.platform === reply.platform)
        if (channel === undefined) {
          // No destination on this platform at all: drop the reply, like the
          // Superagent's own `gone`, and keep the pump moving.
          mark.sent.push(reply.id)
          changed = true
          continue
        }
        if (channel.enabled !== true || !running.has(channel.id) || stop !== null) { stop ??= at; break }
        try {
          await adapters()[channel.platform]?.send(channel, String(reply.chatId), String(reply.text ?? ''))
          mark.sent.push(reply.id)
          changed = true
          channel.stats.sent = (channel.stats.sent ?? 0) + 1
        } catch (error) {
          channel.stats ??= {}
          channel.stats.error = String(error).slice(0, 300)
          stop ??= at
          break
        }
      }
      if (stop !== null) mark.cursor = stop
      else {
        mark.cursor = end
        if (changed && mark.sent.length > OUTBOX_SENT_KEEP) mark.sent = mark.sent.slice(-OUTBOX_SENT_KEEP)
      }
      if (changed) void rt.save().catch(() => {})
    } finally { pumping = false }
  }
  let pumpTimer = null
  const startPump = () => {
    if (pumpTimer !== null) return
    pumpTimer = setInterval(() => { void outboxTick().catch(error => rt.warn('66ai-bot: IM outbox pump failed: %s', error)) }, 2_000)
    pumpTimer.unref?.()
  }
  const stopPump = () => {
    if (pumpTimer !== null) clearInterval(pumpTimer)
    pumpTimer = null
  }

  function channelView(channel) {
    const config = {}
    const fields = PLATFORMS[channel.platform]?.fields ?? []
    for (const field of fields) {
      const value = channel.config?.[field]
      config[field] = field === 'proxy' ? (value ?? '') : mask(value)
    }
    return {
      id: channel.id,
      platform: channel.platform,
      name: channel.name,
      botId: channel.botId,
      botName: botOfChannel(channel)?.name ?? null,
      enabled: channel.enabled === true,
      running: running.has(channel.id),
      trigger: channel.trigger ?? 'mention',
      allowFrom: channel.allowFrom ?? [],
      relay: channel.relay === true,
      config,
      stats: { ...channel.stats ?? {}, running: running.has(channel.id) },
      fields,
      hint: PLATFORMS[channel.platform]?.hint ?? '',
    }
  }

  const channelsView = () => ({ platforms: Object.entries(PLATFORMS).map(([id, meta]) => ({ id, ...meta })), channels: Object.values(state.imChannels).map(channelView) })

  function validate(body, previous) {
    const platform = String(body.platform ?? '')
    if (PLATFORMS[platform] === undefined) throw invalid('Pick a platform')
    const name = String(body.name ?? '').trim() || PLATFORMS[platform].name
    if (name.length > MAX_TITLE) throw invalid(`Keep the name under ${MAX_TITLE} characters`)
    const bot = rt.botOf(body.botId)
    if (bot === undefined) throw invalid('Pick the Bot this channel serves')
    const config = {}
    for (const field of PLATFORMS[platform].fields) {
      const value = body.config?.[field]
      if (field === 'proxy') config[field] = typeof value === 'string' ? value.trim() : ''
      // The masked form came back untouched; the stored secret stays.
      else if (typeof value === 'string' && value.startsWith('••••') && previous?.[field] !== undefined) config[field] = previous[field]
      else if (typeof value !== 'string' || value.trim() === '') throw invalid(`Fill in ${field}`)
      else config[field] = value.trim()
    }
    const trigger = body.trigger === 'all' ? 'all' : 'mention'
    const allowFrom = [...new Set((Array.isArray(body.allowFrom) ? body.allowFrom : []).map(String).map(id => id.trim()).filter(Boolean))]
    return { platform, name, botId: bot.id, config, trigger, allowFrom, relay: body.relay === true }
  }

  async function restart(channel) {
    running.get(channel.id)?.(new AbortController().signal)
    running.delete(channel.id)
    if (channel.enabled !== true) return
    const adapter = adapters()[channel.platform]
    if (adapter === undefined) {
      channel.stats ??= {}
      channel.stats.error = `No adapter for ${channel.platform}`
      return
    }
    const stop = await adapter.start(channel, { onInbound: message => { void onInbound(channel, message).catch(error => rt.warn('66ai-bot: channel %s inbound failed: %s', channel.name, error)) }, report: message => { channel.stats ??= {}; channel.stats.error = String(message).slice(0, 300) } })
    running.set(channel.id, stop)
    channel.stats ??= {}
    channel.stats.error = null
  }

  const stopAll = () => {
    stopPump()
    for (const [id, stop] of running) {
      try { stop(new AbortController().signal) } catch (error) { rt.warn('66ai-bot: channel %s not stopped: %s', id, error) }
    }
    running.clear()
  }

  // The App restores every enabled channel once, after the first full state
  // read: UI load or the settings page, whichever comes first. Idempotent.
  let startedOnce = false
  const ensureStarted = async () => {
    if (startedOnce) return
    startedOnce = true
    await rt.load()
    startPump()
    for (const channel of Object.values(state.imChannels)) {
      if (channel.enabled === true) void restart(channel).catch(error => rt.warn('66ai-bot: channel %s not restarted: %s', channel.name, error))
    }
  }

  const endpoints = {
    'im-channels': () => channelsView(),
    async 'im-channel-save'(body) {
      await rt.load()
      let channel
      if (typeof body.id === 'string' && state.imChannels[body.id] !== undefined) {
        channel = state.imChannels[body.id]
        const next = validate({ ...body, platform: channel.platform }, channel.config)
        Object.assign(channel, { name: next.name, botId: next.botId, config: next.config, trigger: next.trigger, allowFrom: next.allowFrom, relay: next.relay })
        if (typeof body.enabled === 'boolean') channel.enabled = body.enabled
      } else {
        channel = { id: randomUUID(), enabled: body.enabled === true, stats: { received: 0, sent: 0, lastAt: 0, error: null }, ...validate(body) }
        state.imChannels[channel.id] = channel
      }
      await rt.save()
      await restart(channel)
      void rt.save().catch(() => {})
      return channelsView()
    },
    async 'im-channel-toggle'(body) {
      await rt.load()
      const channel = state.imChannels[body.id]
      if (channel === undefined) throw invalid('No such channel')
      channel.enabled = body.enabled === true
      await rt.save()
      await restart(channel)
      void rt.save().catch(() => {})
      return channelsView()
    },
    async 'im-channel-delete'(body) {
      await rt.load()
      const channel = state.imChannels[body.id]
      if (channel === undefined) throw invalid('No such channel')
      running.get(channel.id)?.(new AbortController().signal)
      running.delete(channel.id)
      delete state.imChannels[body.id]
      await rt.save()
      return channelsView()
    },
    // A connection test that runs the platform's own who-am-i call, without
    // touching the stored channel. Returns the platform identity or the error.
    async 'im-channel-test'(body) {
      const platform = String(body.platform ?? '')
      const adapter = adapters()[platform]
      if (adapter === undefined || typeof adapter.test !== 'function') return { ok: false, error: `No adapter for ${platform}` }
      try {
        return { ok: true, ...(await adapter.test(body.config ?? {})) }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error).slice(0, 300) }
      }
    },
  }

  Object.assign(rt, {
    imChannelsView: channelsView,
    imInbound: onInbound,
    imOutboxTick: outboxTick,
    imBridgeDir: bridgeDir,
    imAdaptersSetter: set => { rt.imAdapters = { ...rt.imAdapters, ...set } },
    imRestart: restart,
    imStopAll: stopAll,
    imEnsureStarted: ensureStarted,
    imWaitersMove: rebindWaiters,
    imEndpoint: (endpoint, body) => endpoints[endpoint]?.(body ?? {}),
  })
}
