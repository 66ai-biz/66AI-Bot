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

// The mock keeps the cloud's shapes: one user map, the remote register report with its
// mirror semantics (create with trial; recalibrate a client user's password; never touch
// a web or admin user), and the idempotent points watermark.
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
      return json(response, 200, { ok: true, username: user.username, ...pointsWire(user), sub_text_until: '', sub_analysis_until: '' })
    }
    if (request.url === '/api/report_register') {
      const name = String(data.username ?? '').trim()
      if (name === '') return json(response, 400, { ok: false, error: 'bad payload' })
      const known = users.get(name)
      if (!known) users.set(name, { username: name, password: String(data.password ?? ''), source: 'client', points: { ...TRIAL, universal: 0 } })
      else if (known.source === 'client') known.password = String(data.password ?? '')
      return json(response, 200, { ok: true })
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
        out[user.username] = { exists: true, balances: { ...user.points }, sub_text_until: '', sub_analysis_until: '' }
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

const auth = await import('../src/auth.mjs')

const homeOf = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `aibot-account-${name}-`))
  return dir
}

test('register creates the cloud account with the trial points and signs in', async () => {
  const home = homeOf('new')
  auth.configureAccount({ dataDir: home })
  const result = await auth.registerAccount('  amy ', 'secret-one', 'secret-one')
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.equal(result.account.username, 'amy')
  assert.deepEqual(result.account.points, { ...TRIAL, universal: 0 })
  // The session carries the account and the points.
  const session = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8'))
  assert.equal(session.username, 'amy')
  assert.equal(session.points.video, 200)
  assert.equal(typeof session.deviceId, 'string')
  rmSync(home, { recursive: true, force: true })
})

test('a register with mismatched passwords stops before the network', async () => {
  const home = homeOf('mismatch')
  auth.configureAccount({ dataDir: home })
  const result = await auth.registerAccount('bob', 'secret-one', 'secret-two')
  assert.equal(result.ok, false)
  assert.equal(result.error, '两次输入的密码不一致')
  assert.equal(users.has('bob'), false)
  rmSync(home, { recursive: true, force: true })
})

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

test('registering an existing name with the right password signs in instead', async () => {
  const home = homeOf('again')
  auth.configureAccount({ dataDir: home })
  const result = await auth.registerAccount('amy', 'secret-one', 'secret-one')
  assert.equal(result.ok, true)
  assert.equal(result.existed, true)
  rmSync(home, { recursive: true, force: true })
})

test('a register report over a client account recalibrates its password', async () => {
  const home = homeOf('recalibrate')
  auth.configureAccount({ dataDir: home })
  const result = await auth.registerAccount('amy', 'secret-two', 'secret-two')
  assert.equal(result.ok, true)
  // The old password is gone, the new one signs in.
  const old = await auth.loginAccount('amy', 'secret-one')
  assert.equal(old.ok, false)
  const fresh = await auth.loginAccount('amy', 'secret-two')
  assert.equal(fresh.ok, true)
  rmSync(home, { recursive: true, force: true })
})

test('a web account of the cloud keeps its password', async () => {
  users.set('cara', { username: 'cara', password: 'web-secret', source: 'web', points: { ...TRIAL, universal: 0 } })
  const home = homeOf('web')
  auth.configureAccount({ dataDir: home })
  const result = await auth.registerAccount('cara', 'hijack', 'hijack')
  assert.equal(result.ok, false)
  assert.equal(users.get('cara').password, 'web-secret')
  rmSync(home, { recursive: true, force: true })
})

test('the sync pulls the balances the admin changed on the cloud', async () => {
  const home = homeOf('sync')
  auth.configureAccount({ dataDir: home })
  await auth.loginAccount('amy', 'secret-two')
  users.get('amy').points.text = 500
  users.get('amy').points.universal = 88
  const answer = await auth.syncAccountPoints()
  assert.equal(answer.ok, true)
  assert.equal(answer.account.points.text, 500)
  assert.equal(answer.account.points.universal, 88)
  assert.equal(auth.accountState().points.text, 500)
  rmSync(home, { recursive: true, force: true })
})

test('a recorded spend pushes once and a lost answer cannot deduct twice', async () => {
  const home = homeOf('spend')
  auth.configureAccount({ dataDir: home })
  await auth.loginAccount('amy', 'secret-two')
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
  await auth.loginAccount('amy', 'secret-two')
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
  await auth.loginAccount('amy', 'secret-two')
  const deviceId = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8')).deviceId
  auth.logoutAccount()
  const session = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8'))
  assert.equal(auth.accountState().authed, false)
  assert.equal(session.deviceId, deviceId)
  assert.equal(session.username, undefined)
  rmSync(home, { recursive: true, force: true })
})

test('the plan gate takes both subscriptions or an administrator', () => {
  const today = auth.todayStamp()
  const year = '9999-12-31'
  // Without an account there is nothing to allow.
  assert.equal(auth.planState({ username: '' }).allowed, false)
  assert.equal(auth.planState(undefined).allowed, false)
  // The plan is the pair: one subscription alone does not open the app.
  assert.equal(auth.planState({ username: 'a', subTextUntil: year, subAnalysisUntil: year }).allowed, true)
  assert.equal(auth.planState({ username: 'a', subTextUntil: year, subAnalysisUntil: '' }).allowed, false)
  assert.equal(auth.planState({ username: 'a', subTextUntil: '', subAnalysisUntil: year }).allowed, false)
  // Subscriptions read as valid through their expiry day, the cloud's own comparison.
  assert.equal(auth.planState({ username: 'a', subTextUntil: today, subAnalysisUntil: today }).allowed, true)
  const yesterday = auth.todayStamp(new Date(Date.now() - 86_400_000))
  assert.equal(auth.planState({ username: 'a', subTextUntil: yesterday, subAnalysisUntil: year }).allowed, false)
  // An administrator may use the app without a plan.
  assert.equal(auth.planState({ username: 'a', isAdmin: true }).allowed, true)
  assert.equal(auth.planState({ username: 'a', isAdmin: true }).admin, true)
  // The stamps come back for the paywall to name them.
  const state = auth.planState({ username: 'a', subTextUntil: year, subAnalysisUntil: yesterday })
  assert.equal(state.subTextUntil, year)
  assert.equal(state.subAnalysisUntil, yesterday)
})

after(() => {
  server.closeAllConnections()
  server.close()
})
