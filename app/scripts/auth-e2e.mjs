// Dev check: the 66AI account gate end to end. The app runs on throwaway folders against a
// local mock of the account service (the wire semantics of cm.66ai.biz), the script walks the
// pages the way a user would — the introduction, the sign-in form, the paywall — buys the plan
// at the mock, and it checks that the window then lands on the Host, that the session file
// holds the account, and that a second run walks straight in.
// Usage: node scripts/auth-e2e.mjs  (a mock model server on 8791 is expected, like shot.mjs)
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The mock shares the client secret with the app through the environment; no real
// secret is written here.
process.env.CM_SECRET = 'e2e-secret'
const SECRET = process.env.CM_SECRET
const NAME = 'e2e-account'
const PASSWORD = 'e2e-secret-1'
const TRIAL = { image: 15, video: 200, text: 10, analysis: 10, app: 10 }

// The mock of the account service: the same three endpoints the cloud serves.
const users = new Map()
const cm = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    const data = JSON.parse(body || '{}')
    const json = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (data.secret !== SECRET) return json(403, { ok: false, error: 'denied' })
    if (request.url === '/e2e_grant_plan') {
      // The script's stand-in for the purchase on the unified account site.
      const user = users.get(String(data.username ?? ''))
      if (user === undefined) return json(404, { ok: false, error: 'no such user' })
      user.subText = '9999-12-31'
      user.subAnalysis = '9999-12-31'
      return json(200, { ok: true })
    }
    if (request.url === '/api/client/remote_login') {
      const user = users.get(String(data.username ?? ''))
      if (!user || user.password !== String(data.password ?? '')) return json(401, { ok: false, error: '用户名或密码错误' })
      return json(200, { ok: true, username: user.username, points_image: user.points.image, points_video: user.points.video, points_text: user.points.text, points_analysis: user.points.analysis, points_app: user.points.app, points_universal: 0, sub_text_until: user.subText ?? '', sub_analysis_until: user.subAnalysis ?? '', is_admin: false })
    }
    if (request.url === '/api/report_register') {
      const name = String(data.username ?? '').trim()
      if (name === '') return json(400, { ok: false, error: 'bad payload' })
      if (!users.has(name)) users.set(name, { username: name, password: String(data.password ?? ''), points: { ...TRIAL } })
      return json(200, { ok: true })
    }
    if (request.url === '/api/client/points_sync') {
      const out = {}
      for (const item of Array.isArray(data.users) ? data.users : []) {
        const user = users.get(String(item.username ?? ''))
        if (!user) { out[item.username] = { exists: false }; continue }
        out[user.username] = { exists: true, balances: { ...user.points, universal: 0 }, sub_text_until: user.subText ?? '', sub_analysis_until: user.subAnalysis ?? '' }
      }
      return json(200, { ok: true, users: out })
    }
    json(404, { ok: false, error: 'not found' })
  })
})
const cmPort = await new Promise((done) => { cm.listen(0, '127.0.0.1', () => done(cm.address().port)) })
console.log(`auth-e2e: the account mock serves on ${String(cmPort)}`)
// The account exists on the cloud before the app starts: accounts are created on the
// unified site, the app only signs in.
users.set(NAME, { username: NAME, password: PASSWORD, points: { ...TRIAL }, subText: '', subAnalysis: '' })

const shellData = mkdtempSync(join(tmpdir(), 'aibot-auth-shell-'))
const home = mkdtempSync(join(tmpdir(), 'aibot-auth-home-'))
const electron = createRequire(import.meta.url)('electron')
const port = 9900 + Math.floor(Math.random() * 90)
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...baseEnv } = process.env
const env = {
  ...baseEnv,
  AIBOT_HOME: home, AIBOT_SHELL_DATA: shellData,
  CM_BASE_URL: `http://127.0.0.1:${String(cmPort)}`, CM_SECRET: SECRET,
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:8791/v1', DEEPSEEK_API_KEY: 'mock-key',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '*',
}

function devtools(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    pending.set(id, { resolve: done, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => { socket.close() } }
}

async function waitFor(deadline, what) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const pages = targets.filter((target) => target.type === 'page')
      const found = await what(pages)
      if (found !== undefined) return found
    } catch {
      // The debugging port is not listening yet.
    }
    await sleep(500)
  }
  throw new Error('auth-e2e: timed out')
}

const hostPage = async (pages) => pages.find((target) => /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))

// The app's own pages all load as data:URLs; each carries a mark only it has.
async function ownPage(pages, expression) {
  const target = pages.find((target) => target.url.startsWith('data:text/html'))
  if (target === undefined) return undefined
  const cdp = devtools(target.webSocketDebuggerUrl)
  await cdp.opened
  const { result } = await cdp.call('Runtime.evaluate', { expression: `String(${expression})`, returnByValue: true })
  cdp.close()
  return result.value === 'true' ? target : undefined
}
const introPage = async (pages) => ownPage(pages, 'document.getElementById("btnLogin") !== null && document.getElementById("formLogin") === null')
const loginPage = async (pages) => ownPage(pages, 'document.getElementById("formLogin") !== null')
const paywallPage = async (pages) => ownPage(pages, 'document.getElementById("btnCheck") !== null')

async function run(what) {
  const child = spawn(electron, [root, `--remote-debugging-port=${String(port)}`], { stdio: 'ignore', env })
  const exited = new Promise((done) => { child.once('exit', done) })
  const outcome = await what()
  await sleep(1500)
  try {
    const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
    const browser = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((done, reject) => {
      browser.addEventListener('open', done, { once: true })
      browser.addEventListener('error', reject, { once: true })
    })
    browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    browser.close()
  } catch {
    child.kill()
  }
  await Promise.race([exited, sleep(30_000).then(() => { child.kill() })])
  return outcome
}

let failed = false
try {
  // --- The first run: the introduction offers the sign-in, the form signs the account in,
  // --- the paywall stands until the plan is bought, then the window lands on the Host.
  await run(async () => {
    const deadline = Date.now() + 120_000
    const target = await waitFor(deadline, introPage)
    console.log('auth-e2e: the introduction page is up')
    let cdp = devtools(target.webSocketDebuggerUrl)
    await cdp.opened
    await cdp.call('Runtime.evaluate', { expression: 'document.getElementById("btnLogin").click()' })
    cdp.close()
    const form = await waitFor(deadline, loginPage)
    console.log('auth-e2e: the sign-in page is up')
    cdp = devtools(form.webSocketDebuggerUrl)
    await cdp.opened
    await cdp.call('Runtime.evaluate', { expression: `
      document.getElementById("liUser").value = ${JSON.stringify(NAME)}
      document.getElementById("liPass").value = ${JSON.stringify(PASSWORD)}
      undefined` })
    await cdp.call('Runtime.evaluate', { expression: 'document.getElementById("liGo").click()' })
    // Without the plan the sign-in stops at the paywall.
    const wall = await waitFor(deadline, paywallPage)
    console.log('auth-e2e: the paywall stands for an account without the plan')
    cdp.close()
    // The purchase happens on the unified site; the mock grants the plan here.
    const grant = await fetch(`http://127.0.0.1:${String(cmPort)}/e2e_grant_plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET, username: NAME }),
    })
    if (!grant.ok) throw new Error('auth-e2e: the mock refused to grant the plan')
    // The paywall's own re-check should then let the gate go.
    cdp = devtools(wall.webSocketDebuggerUrl)
    await cdp.opened
    await cdp.call('Runtime.evaluate', { expression: 'document.getElementById("btnCheck").click()' })
    try {
      await waitFor(deadline, hostPage)
    } catch (error) {
      const { result } = await cdp.call('Runtime.evaluate', { expression: 'document.body.innerText.slice(0, 300)', returnByValue: true })
      throw new Error(`auth-e2e: the Host never came up after the plan (page says: ${String(result.value)})`, { cause: error })
    }
    cdp.close()
    console.log('auth-e2e: the plan checked out and the window landed on the Host')
    const session = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8'))
    if (session.username !== NAME || session.points.text !== TRIAL.text) {
      throw new Error(`auth-e2e: the session file is wrong: ${JSON.stringify({ username: session.username, points: session.points })}`)
    }
    console.log(`auth-e2e: the session holds ${NAME} with the trial points`)
    return true
  })

  // --- The second run: the saved account walks straight in, no sign-in page.
  await run(async () => {
    const deadline = Date.now() + 90_000
    const target = await waitFor(deadline, hostPage)
    const cdp = devtools(target.webSocketDebuggerUrl)
    await cdp.opened
    const { result } = await cdp.call('Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, account: String(window.aibotAuth !== undefined) })', returnByValue: true,
    })
    cdp.close()
    console.log(`auth-e2e: the second run went straight in: ${String(result.value)}`)
    return true
  })
  const shot = resolve('auth-e2e.png')
  console.log(`auth-e2e: PASS`)
  rmSync(shot, { force: true })
} catch (error) {
  failed = true
  console.error(error)
} finally {
  cm.closeAllConnections?.()
  cm.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(shellData, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
