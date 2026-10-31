// The 66AI account module against a mock of the cloud account service: the wire
// semantics the mock follows are the ones of cm.66ai.biz (the CanvasMind backend),
// checked against the live service by the register/sign-in handshake probes.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CM_BASE_URL = 'http://127.0.0.1:0' // replaced below before the module reads it
// The mock shares this value with the module through the environment, the way a
// self-hosted deployment would; no real secret is written here.
process.env.CM_SECRET = 'e2e-secret'

const SECRET = process.env.CM_SECRET
const TRIAL = { image: 15, video: 200, text: 10, analysis: 10, app: 10 }

// The mock keeps the cloud's shapes: one user map (accounts are created on the web
// side or by the admin, never from the desktop app) and the idempotent points
// watermark. A user carries the subscription stamps, the relay key and the agent
// slots the way the live cloud hands them over.
const users = new Map()
const watermark = new Map()
let failNext = false

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    const data = JSON.parse(body || '{}')
    if (failNext) { failNext = false; request.destroy(); return }
    if (data.secret !== SECRET) return json(response, 403, { ok: false, error: 'denied' })
    if (request.url === '/api/client/remote_login') {
      const user = users.get(String(data.username ?? ''))
      if (!user || user.password !== String(data.password ?? '')) return json(response, 401, { ok: false, error: '用户名或密码错误' })
      return json(response, 200, {
        ok: true, username: user.username, ...pointsWire(user),
        sub_text_until: user.subTextUntil ?? '', sub_analysis_until: '',
        sub_aibot_until: user.subBotUntil ?? '', relay_key: user.relayKey ?? '',
        agent_slots: user.agentSlots ?? 0,
      })
    }
    if (request.url === '/api/client/points_sync') {
      const out = {}
      for (const item of Array.isArray(data.users) ? data.users : []) {
        const user = users.get(String(item.username ?? ''))
        if (!user) { out[item.username] = { exists: false }; continue }
        const seen = watermark.get(user.username) ?? 0
        const id = Number(item.spend_max_id ?? 0)
        if (id > seen) {
          watermark.set(user.username, id)
          for (const [key, value] of Object.entries(item.spend ?? {})) {
            const amount = Math.trunc(Number(value) || 0)
            if (amount < 0) user.points[key] = (user.points[key] ?? 0) + amount
          }
        }
        out[user.username] = {
          exists: true, balances: { ...user.points },
          sub_text_until: user.subTextUntil ?? '', sub_analysis_until: '',
          sub_aibot_until: user.subBotUntil ?? '', relay_key: user.relayKey ?? '',
          agent_slots: user.agentSlots ?? 0,
        }
      }
      return json(response, 200, { ok: true, users: out })
    }
    json(response, 404, { ok: false, error: 'not found' })
  })
})

const pointsWire = (user) => Object.fromEntries([
  ...Object.entries(user.points).map(([key, value]) => [`points_${key}`, value]),
  ['points_universal', user.points.universal ?? 0],
])

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
process.env.CM_BASE_URL = `http://127.0.0.1:${String(port)}`

// Seeded before the module import so the first sign-in finds them.
users.set('amy', { username: 'amy', password: 'secret-one', source: 'client', points: { ...TRIAL, universal: 0 }, subBotUntil: '9999-12-31', relayKey: 'sk-amy-relay', agentSlots: 5 })
users.set('lone', { username: 'lone', password: 'secret-one', source: 'client', points: { ...TRIAL, universal: 0 }, subBotUntil: '', relayKey: '', agentSlots: 0 })

const auth = await import('../src/auth.mjs')

const homeOf = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `aibot-account-${name}-`))
  return dir
}

test('sign-in checks the password against the cloud and stores the session', async () => {
  const home = homeOf('login')
  auth.configureAccount({ dataDir: home })
  const bad = await auth.loginAccount('amy', 'wrong-password')
  assert.equal(bad.ok, false)
  assert.equal(bad.error, '用户名或密码错误')
  const good = await auth.loginAccount('amy', 'secret-one')
  assert.equal(good.ok, true)
  assert.equal(auth.accountState().authed, true)
  assert.equal(auth.accountState().username, 'amy')
  rmSync(home, { recursive: true, force: true })
})

test('sign-in carries the relay key, the plan stamp and the agent slots', async () => {
  const home = homeOf('entitlements')
  auth.configureAccount({ dataDir: home })
  const result = await auth.loginAccount('amy', 'secret-one')
  assert.equal(result.ok, true)
  assert.equal(result.account.subBotUntil, '9999-12-31')
  assert.equal(result.account.relayKey, 'sk-amy-relay')
  assert.equal(result.account.agentSlots, 5)
  const session = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8'))
  assert.equal(session.relayKey, 'sk-amy-relay')
  assert.equal(session.agentSlots, 5)
  // The account state hands both to the app, which parks them for the Host.
  assert.equal(auth.accountState().relayKey, 'sk-amy-relay')
  assert.equal(auth.accountState().agentSlots, 5)
  rmSync(home, { recursive: true, force: true })
})

test('the sync pulls the balances the admin changed on the cloud', async () => {
  const home = homeOf('sync')
  auth.configureAccount({ dataDir: home })
  await auth.loginAccount('amy', 'secret-one')
  users.get('amy').points.text = 500
  users.get('amy').points.universal = 88
  const answer = await auth.syncAccountPoints()
  assert.equal(answer.ok, true)
  assert.equal(answer.account.points.text, 500)
  assert.equal(answer.account.points.universal, 88)
  assert.equal(auth.accountState().points.text, 500)
  rmSync(home, { recursive: true, force: true })
})

test('the sync follows a rotated relay key, a new plan stamp and new agent slots', async () => {
  const home = homeOf('rotate')
  auth.configureAccount({ dataDir: home })
  await auth.loginAccount('amy', 'secret-one')
  users.get('amy').relayKey = 'sk-rotated'
  users.get('amy').subBotUntil = '2099-01-31'
  users.get('amy').agentSlots = 3
  const answer = await auth.syncAccountPoints()
  assert.equal(answer.ok, true)
  assert.equal(auth.accountState().relayKey, 'sk-rotated')
  assert.equal(auth.accountState().subBotUntil, '2099-01-31')
  assert.equal(auth.accountState().agentSlots, 3)
  rmSync(home, { recursive: true, force: true })
})

test('a recorded spend pushes once and a lost answer cannot deduct twice', async () => {
  const home = homeOf('spend')
  auth.configureAccount({ dataDir: home })
  await auth.loginAccount('amy', 'secret-one')
  const before = users.get('amy').points.text
  assert.equal(auth.recordSpend({ text: -3, nonsense: -9, positive: 5 }), true)
  const first = await auth.syncAccountPoints()
  assert.equal(first.ok, true)
  assert.equal(users.get('amy').points.text, before - 3)
  // A second sync without a new spend leaves the balance alone.
  await auth.syncAccountPoints()
  assert.equal(users.get('amy').points.text, before - 3)
  // A spend whose answer is lost keeps its watermark and deduts once when it retries.
  assert.equal(auth.recordSpend({ text: -2 }), true)
  failNext = true
  const lost = await auth.syncAccountPoints()
  assert.equal(lost.ok, false)
  assert.equal(users.get('amy').points.text, before - 3)
  const retry = await auth.syncAccountPoints()
  assert.equal(retry.ok, true)
  assert.equal(users.get('amy').points.text, before - 5)
  rmSync(home, { recursive: true, force: true })
})

test('an unreachable account service answers as a network failure', async () => {
  const home = homeOf('network')
  auth.configureAccount({ dataDir: home })
  await auth.loginAccount('amy', 'secret-one')
  const lastKnown = auth.accountState().points.text
  server.close()
  try {
    const answer = await auth.syncAccountPoints()
    assert.equal(answer.ok, false)
    assert.equal(answer.network, true)
    // The session keeps its last known balances.
    assert.equal(auth.accountState().points.text, lastKnown)
  } finally {
    await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve) })
  }
  rmSync(home, { recursive: true, force: true })
})

test('signing out keeps only the device id', async () => {
  const home = homeOf('logout')
  auth.configureAccount({ dataDir: home })
  await auth.loginAccount('amy', 'secret-one')
  const deviceId = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8')).deviceId
  auth.logoutAccount()
  const session = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8'))
  assert.equal(auth.accountState().authed, false)
  assert.equal(session.deviceId, deviceId)
  assert.equal(session.username, undefined)
  rmSync(home, { recursive: true, force: true })
})

test('the plan gate is a subscribed 66AI Bot plan or an administrator', () => {
  const today = auth.todayStamp()
  const year = '9999-12-31'
  // Without an account there is nothing to allow.
  assert.equal(auth.planState({ username: '' }).allowed, false)
  assert.equal(auth.planState(undefined).allowed, false)
  // The AIBot plan alone opens the app; the older text/analysis pair does not.
  assert.equal(auth.planState({ username: 'a', subBotUntil: year }).allowed, true)
  assert.equal(auth.planState({ username: 'a', subTextUntil: year, subAnalysisUntil: year }).allowed, false)
  assert.equal(auth.planState({ username: 'a', subBotUntil: '' }).allowed, false)
  // The plan reads as valid through its expiry day, the cloud's own comparison.
  assert.equal(auth.planState({ username: 'a', subBotUntil: today }).allowed, true)
  const yesterday = auth.todayStamp(new Date(Date.now() - 86_400_000))
  assert.equal(auth.planState({ username: 'a', subBotUntil: yesterday }).allowed, false)
  // An administrator may use the app without a plan.
  assert.equal(auth.planState({ username: 'a', isAdmin: true }).allowed, true)
  assert.equal(auth.planState({ username: 'a', isAdmin: true }).admin, true)
  // The stamps come back for the paywall to name them.
  const state = auth.planState({ username: 'a', subBotUntil: year, subTextUntil: yesterday })
  assert.equal(state.subBotUntil, year)
  assert.equal(state.subTextUntil, yesterday)
})

after(() => {
  server.closeAllConnections()
  server.close()
})
