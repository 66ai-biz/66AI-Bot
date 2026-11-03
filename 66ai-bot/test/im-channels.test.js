import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// IM channels over the real module: save/list with masked tokens, a mock
// adapter carrying an inbound message to the Bot and its turn back to the chat,
// and the mention and allow-list gates.
const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: { chief: { id: 'chief', sessionId: 'chief-s1', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start() {
  const home = mkdtempSync(join(tmpdir(), '66ai-bot-im-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const prompts = []
  let promptArrived
  const promptPromise = () => new Promise(resolve => { promptArrived = resolve })
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 'chief-s1' }),
      resolveAgent: async id => ({ agent: { id, session: { id } } }),
      prompt: async request => {
        prompts.push(request)
        promptArrived?.()
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false, imBridgeDir: join(home, 'im-bridge') })
  // A mock platform adapter: no network, records starts and sends.
  const adapter = {
    platform: 'telegram',
    started: [],
    stopped: [],
    sent: [],
    async start(channel, handlers) {
      adapter.started.push(channel.id)
      adapter.handlers = handlers
      return signal => { adapter.stopped.push(channel.id); void signal }
    },
    async send(channel, chatId, text) { adapter.sent.push({ chatId, text }) },
    async test() { return { name: '@mockbot' } },
  }
  rt.imAdaptersSetter({ telegram: adapter })
  const emit = (session, event) => { for (const listener of ctx.listeners.get('session/event') ?? []) listener(session, event) }
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, adapter, prompts, promptPromise, emit, call, stop }
}

test('a channel saves with a masked token and shows its running state', async (t) => {
  const { rt, adapter, stop } = start()
  t.after(stop)
  await rt.load()
  const view = await rt.imEndpoint('im-channel-save', {
    platform: 'telegram',
    name: 'TG desk',
    botId: 'chief',
    config: { token: '123456:ABC-supersecret', proxy: '' },
  })
  assert.equal(view.channels.length, 1)
  const saved = view.channels[0]
  assert.equal(saved.platform, 'telegram')
  assert.equal(saved.enabled, false, 'a new channel starts stopped')
  assert.ok(!String(saved.config.token).includes('supersecret'), 'the token never leaves the host')
  assert.match(saved.config.token, /^••••/)
  assert.equal(saved.botName, 'Chief')

  const on = await rt.imEndpoint('im-channel-toggle', { id: saved.id, enabled: true })
  assert.equal(on.channels[0].enabled, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(adapter.started, [saved.id], 'the adapter starts with the channel')
  assert.equal(on.channels[0].running, true)

  const off = await rt.imEndpoint('im-channel-toggle', { id: saved.id, enabled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(adapter.stopped, [saved.id], 'disabling stops the adapter')
  assert.equal(off.channels[0].running, false)
})

test('an inbound message reaches the Bot and its reply reaches the chat', async (t) => {
  const { rt, adapter, prompts, promptPromise, emit, stop } = start()
  t.after(stop)
  await rt.load()
  const view = await rt.imEndpoint('im-channel-save', {
    platform: 'telegram', name: 'tg', botId: 'chief', enabled: true,
    config: { token: '123456:tok', proxy: '' },
  })
  const channelId = view.channels[0].id
  await new Promise(resolve => setImmediate(resolve))
  const state = rt.state.imChannels[channelId]

  const delivery = rt.imInbound(state, { chatId: '100', chatType: 'private', userId: 'u1', userName: 'Ann', text: '帮我看看数据', mentioned: true })
  await promptPromise()
  assert.equal(prompts.length, 1)
  assert.match(String(prompts[0].content?.[0]?.text ?? prompts[0].content), /Ann on Telegram/, 'the prompt names its origin')
  assert.match(String(prompts[0].content?.[0]?.text ?? prompts[0].content), /帮我看看数据/)
  assert.equal(prompts[0].sessionId, 'chief-s1', 'it lands on the Bot\'s own chat')

  // The Bot's turn speaks twice and ends; the chat gets the whole turn.
  emit({ id: 'chief-s1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正在分析。' }] } } })
  emit({ id: 'chief-s1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '结论：本周增长 12%。' }] } } })
  emit({ id: 'chief-s1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await delivery
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapter.sent.length, 1)
  assert.equal(adapter.sent[0].chatId, '100')
  assert.ok(adapter.sent[0].text.includes('正在分析。') && adapter.sent[0].text.includes('12%'), 'the reply carries the turn\'s texts')
  assert.equal(state.stats.received, 1)
  assert.equal(state.stats.sent, 1)
})

test('a group message without a mention waits, and a stranger outside the allow list is ignored', async (t) => {
  const { rt, adapter, prompts, promptPromise, emit, stop } = start()
  t.after(stop)
  await rt.load()
  const view = await rt.imEndpoint('im-channel-save', {
    platform: 'telegram', name: 'tg', botId: 'chief', enabled: true,
    trigger: 'mention', allowFrom: ['200'],
    config: { token: 'tok', proxy: '' },
  })
  const channelId = view.channels[0].id
  await new Promise(resolve => setImmediate(resolve))
  const state = rt.state.imChannels[channelId]

  // A group message with no @mention: dropped before the Bot hears of it.
  await rt.imInbound(state, { chatId: 'g1', chatType: 'group', userId: 'u9', userName: 'Zed', text: 'hello', mentioned: false })
  assert.equal(prompts.length, 0, 'no mention, no turn')
  // A user outside the allow list: dropped too.
  await rt.imInbound(state, { chatId: '999', chatType: 'private', userId: 'u-stanger', userName: 'Eve', text: 'hello', mentioned: true })
  assert.equal(prompts.length, 0, 'the allow list holds')
  // The listed user in the same group with a mention: through.
  const delivery = rt.imInbound(state, { chatId: 'g1', chatType: 'group', userId: '200', userName: 'Bo', text: 'hi', mentioned: true })
  await promptPromise()
  assert.equal(prompts.length, 1)
  emit({ id: 'chief-s1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hi Bo!' }] } } })
  emit({ id: 'chief-s1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await delivery
  assert.ok(adapter.sent[0]?.text.includes('Hi Bo'))
})

test('the connection test runs the adapter without saving anything', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  const good = await rt.imEndpoint('im-channel-test', { platform: 'telegram', config: { token: 'x' } })
  assert.equal(good.ok, true)
  assert.equal(good.name, '@mockbot')
  const unknown = await rt.imEndpoint('im-channel-test', { platform: 'nope', config: {} })
  assert.equal(unknown.ok, false)
  const before = await rt.imEndpoint('im-channels', {})
  assert.equal(before.channels.length, 0, 'a test saves nothing')
})

test('deleting a channel stops it and removes it from the state', async (t) => {
  const { rt, adapter, stop } = start()
  t.after(stop)
  await rt.load()
  const view = await rt.imEndpoint('im-channel-save', {
    platform: 'telegram', name: 'tg', botId: 'chief', enabled: true,
    config: { token: 'tok', proxy: '' },
  })
  const id = view.channels[0].id
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(adapter.started, [id])
  const after = await rt.imEndpoint('im-channel-delete', { id })
  assert.equal(after.channels.length, 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(adapter.stopped, [id])
  assert.equal(rt.state.imChannels[id], undefined)
})

test('over HTTP the channel saves, and a masked token sent back keeps the stored secret', async (t) => {
  const { rt, adapter, call, stop } = start()
  t.after(stop)
  await rt.load()
  const saved = await call('im-channel-save', {
    platform: 'telegram', name: 'tg desk', botId: 'chief',
    config: { token: '123456:ABC-realtoken', proxy: '' },
  })
  assert.equal(saved.ok, true)
  const channel = saved.value.channels[0]
  assert.match(channel.config.token, /^••••/, 'the token leaves the host masked')
  // The form sends the masked value back untouched: the real token survives.
  const edited = await call('im-channel-save', {
    id: channel.id, name: 'tg desk 2', botId: 'chief', enabled: true,
    config: { token: channel.config.token, proxy: 'http://127.0.0.1:7890' },
  })
  assert.equal(edited.value.channels[0].name, 'tg desk 2')
  assert.equal(rt.state.imChannels[channel.id].config.token, '123456:ABC-realtoken', 'the real token stays')
  assert.equal(rt.state.imChannels[channel.id].config.proxy, 'http://127.0.0.1:7890')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(adapter.started, [channel.id], 'the save restarts the channel')
  // The HTTP test endpoint runs the adapter without saving anything.
  const tested = await call('im-channel-test', { platform: 'telegram', config: { token: 'x' } })
  assert.equal(tested.value.ok, true)
  assert.equal(tested.value.name, '@mockbot')
})

// Work mode: the message goes over the file bridge to the dsh-superagent IM
// Source instead of a chat turn; its replies come back through the outbox pump.
test('work mode relays the message to the bridge inbox instead of chatting', async (t) => {
  const { rt, prompts, stop } = start()
  t.after(stop)
  await rt.load()
  const view = await rt.imEndpoint('im-channel-save', {
    platform: 'telegram', name: 'work', botId: 'chief', enabled: true, relay: true,
    config: { token: '123456:tok', proxy: '' },
  })
  assert.equal(view.channels[0].relay, true, 'the view carries the mode')
  const state = rt.state.imChannels[view.channels[0].id]
  await new Promise(resolve => setImmediate(resolve))
  await rt.imInbound(state, { chatId: '200', chatType: 'group', userId: 'u9', userName: 'Ben', text: '修一下下载站', mentioned: true })
  assert.equal(prompts.length, 0, 'work mode does not chat')
  const relayed = JSON.parse(readFileSync(join(rt.imBridgeDir(), 'inbox.jsonl'), 'utf8').trim())
  assert.equal(relayed.platform, 'telegram')
  assert.equal(relayed.chatId, '200')
  assert.equal(relayed.userId, 'u9')
  assert.equal(relayed.mentioned, true)
  assert.equal(typeof relayed.id, 'string')
  assert.equal(state.stats.relayed, 1)
})

test('the outbox pump sends each superagent reply once through the adapter', async (t) => {
  const { rt, adapter, stop } = start()
  t.after(stop)
  await rt.load()
  const view = await rt.imEndpoint('im-channel-save', {
    platform: 'telegram', name: 'work', botId: 'chief', enabled: true, relay: true,
    config: { token: '123456:tok', proxy: '' },
  })
  const channelId = view.channels[0].id
  await new Promise(resolve => setImmediate(resolve))
  mkdirSync(rt.imBridgeDir(), { recursive: true })
  const outbox = join(rt.imBridgeDir(), 'outbox.jsonl')
  writeFileSync(outbox, `${JSON.stringify({ id: 'r1', platform: 'telegram', chatId: '200', text: '工单 #1 已完成' })}\nnot json\n\n${JSON.stringify({ id: 'r2', platform: 'telegram', chatId: '200', text: '第二条' })}\n`)
  await rt.imOutboxTick()
  assert.deepEqual(adapter.sent.map(item => item.text), ['工单 #1 已完成', '第二条'], 'the reply lines go out in order, junk skipped')
  assert.ok(rt.state.imOutbox.sent.includes('r1') && rt.state.imOutbox.sent.includes('r2'))
  assert.equal(rt.state.imOutbox.cursor, readFileSync(outbox).length, 'the cursor sits at the end of the file')
  // A restart replays the file from zero; the sent ids dedupe it.
  rt.state.imOutbox.cursor = 0
  await rt.imOutboxTick()
  assert.equal(adapter.sent.length, 2, 'nothing is sent twice')
  assert.equal(rt.state.imOutbox.cursor, readFileSync(outbox).length)
  // A reply for a platform with no channel drops; a stopped destination holds the rest.
  appendFileSync(outbox, `${JSON.stringify({ id: 'r3', platform: 'discord', chatId: 'x', text: '没人' })}\n${JSON.stringify({ id: 'r4', platform: 'telegram', chatId: '200', text: '排队' })}\n`)
  await rt.imEndpoint('im-channel-toggle', { id: channelId, enabled: false })
  await rt.imOutboxTick()
  assert.ok(rt.state.imOutbox.sent.includes('r3'), 'a platform with no channel drops the reply')
  assert.ok(!rt.state.imOutbox.sent.includes('r4'), 'a stopped destination holds the line back')
  await rt.imEndpoint('im-channel-toggle', { id: channelId, enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await rt.imOutboxTick()
  assert.ok(rt.state.imOutbox.sent.includes('r4'), 'the held line goes out once the channel is back')
  assert.equal(adapter.sent.length, 3, 'three telegram sends in total; the discord line went nowhere')
})
