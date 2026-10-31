// The 66AI account: register and sign in against the cloud account service
// (cm.66ai.biz, the CanvasMind backend), which keeps one user list for the web,
// the admin console and the desktop clients. An account created here is the same
// account everywhere: the cloud mirrors it into its unified user list with the
// standard trial points, and the balances follow the cloud (admin top-ups land
// here at the next sync; local spends can be pushed back the same way).
//
// The cloud endpoints are the ones the CanvasMind clients already use:
//   POST /api/client/remote_login  — verify a name and password, return the account
//   POST /api/report_register      — create (or recalibrate) a client account
//   POST /api/client/points_sync   — pull balances, push spends (idempotent watermark)
// All three answer JSON and share the client secret of the deployment.

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The cloud base and the shared secret come from the deployment; tests point CM_BASE_URL
// at a local mock. The fetch of the main process connects directly (no proxy is honoured).
export const CLOUD_BASE = (process.env.CM_BASE_URL ?? 'https://cm.66ai.biz').replace(/\/+$/u, '')
const SECRET = process.env.CM_SECRET ?? 'cm61-x7Kp9QwR3vNt8Zs5B2mH'
const REQUEST_TIMEOUT_MS = 12_000
// The cloud's standard trial (图15/视频200/文10/析10/应10). The cloud grants its own
// configured amounts; this number is only what the register report records.
const TRIAL_TOTAL = 245
// The five categories plus the universal one, in the shape the cloud speaks.
const POINT_KEYS = ['image', 'video', 'text', 'analysis', 'app', 'universal']

// The session lives next to the app's data; the boot points this at the chosen
// data directory once it knows it, and until then this is the default home.
let dataDir = process.env.AIBOT_HOME ?? join(homedir(), '.66ai-bot')

/** Point the session file at the app's data directory once the boot has chosen it. */
export function configureAccount({ dataDir: dir } = {}) {
  if (typeof dir === 'string' && dir !== '') dataDir = dir
  cachedSession = undefined
}

function sessionFile() { return join(dataDir, 'account.json') }

let cachedSession

function loadSession() {
  if (cachedSession !== undefined) return cachedSession
  cachedSession = null
  try {
    if (existsSync(sessionFile())) {
      const parsed = JSON.parse(readFileSync(sessionFile(), 'utf8'))
      if (parsed !== null && typeof parsed === 'object') cachedSession = parsed
    }
  } catch (error) {
    console.error('66AI Bot: could not read the account', error)
  }
  return cachedSession
}

function saveSession(session) {
  cachedSession = session
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(sessionFile(), `${JSON.stringify(session, null, 2)}\n`)
  } catch (error) {
    console.error('66AI Bot: could not save the account', error)
  }
}

// A stable id for the register report, kept in the session file.
function deviceId() {
  const session = loadSession()
  if (typeof session?.deviceId === 'string' && session.deviceId !== '') return session.deviceId
  const id = randomUUID()
  saveSession({ ...(session ?? {}), deviceId: id })
  return id
}

async function postJson(pathname, payload = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${CLOUD_BASE}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, ...payload }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({}))
    return { status: response.status, data }
  } catch (error) {
    console.error(`66AI Bot: the account service could not be reached (${pathname})`, error?.cause ?? error)
    return { status: 0, data: {}, network: true }
  } finally {
    clearTimeout(timer)
  }
}

function accountOf(data) {
  const points = {}
  for (const key of POINT_KEYS) {
    const raw = key === 'universal' ? data?.points_universal : data?.[`points_${key}`]
    points[key] = Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : 0
  }
  return {
    username: String(data?.username ?? ''),
    points,
    subTextUntil: String(data?.sub_text_until ?? ''),
    subAnalysisUntil: String(data?.sub_analysis_until ?? ''),
    subBotUntil: String(data?.sub_aibot_until ?? ''),
    // undefined: the cloud said nothing (an older answer); '' : it said there is none.
    relayKey: typeof data?.relay_key === 'string' ? data.relay_key : undefined,
    // The agent slots the plan grants (the cloud computes them); undefined when unstated.
    agentSlots: Number.isFinite(Number(data?.agent_slots)) ? Math.max(0, Math.trunc(Number(data.agent_slots))) : undefined,
    isAdmin: data?.is_admin === true,
  }
}

// The plan the desktop app requires: the cloud's 98-yuan universal bundle. The cloud
// opens it as both the text and the analysis subscription; an administrator may use
// the app without one. Subscriptions read as valid through their expiry day, the
// same comparison the cloud itself makes on the `YYYY-MM-DD` stamps.
export const PLAN_URL = 'https://cm.66ai.biz/pay'

/** The local date as the cloud stamps subscriptions: `YYYY-MM-DD`. */
export function todayStamp(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${String(now.getFullYear())}-${month}-${day}`
}

/** Whether `account` may use the app, with the facts the paywall pages show. */
export function planState(account) {
  const source = account ?? loadSession()
  const subTextUntil = String(source?.subTextUntil ?? '')
  const subAnalysisUntil = String(source?.subAnalysisUntil ?? '')
  const subBotUntil = String(source?.subBotUntil ?? '')
  const admin = source?.isAdmin === true
  if (typeof source?.username !== 'string' || source.username === '') {
    return { allowed: false, admin, subBotUntil, subTextUntil, subAnalysisUntil }
  }
  if (admin) return { allowed: true, admin, subBotUntil, subTextUntil, subAnalysisUntil }
  const today = todayStamp()
  return {
    // The app's gate is a subscribed 66AI Bot monthly plan (the cloud's sub_aibot);
    // an administrator may use the app without one.
    allowed: subBotUntil >= today,
    admin,
    subBotUntil,
    subTextUntil,
    subAnalysisUntil,
  }
}

// The cloud's word on a name and a password: `{ ok, account }`, `{ ok: false, error }`
// or `{ network: true }` when the service could not be reached at all.
async function remoteLogin(username, password) {
  const answer = await postJson('/api/client/remote_login', { username, password })
  if (answer.network) return { network: true }
  if (answer.status === 200 && answer.data?.ok === true) return { ok: true, account: accountOf(answer.data) }
  if (answer.status === 429) return { ok: false, error: '尝试过于频繁，请稍后再试' }
  return { ok: false, error: String(answer.data?.error ?? '用户名或密码错误') }
}

function keep(account, extra = {}) {
  const session = loadSession() ?? {}
  saveSession({
    ...session,
    deviceId: session.deviceId ?? randomUUID(),
    username: account.username,
    loggedInAt: new Date().toISOString(),
    points: account.points,
    subTextUntil: account.subTextUntil,
    subAnalysisUntil: account.subAnalysisUntil,
    subBotUntil: account.subBotUntil,
    relayKey: account.relayKey !== undefined ? account.relayKey : String(session.relayKey ?? ''),
    agentSlots: account.agentSlots !== undefined ? account.agentSlots : Math.max(0, Math.trunc(Number(session.agentSlots ?? 0))),
    isAdmin: account.isAdmin === true,
    spendPending: session.spendPending ?? {},
    ...extra,
  })
  return { ok: true, account, created: extra.created === true, existed: extra.existed === true }
}

/** Sign in with the cloud. The answer carries the account on `{ ok, account }`. */
export async function loginAccount(username, password) {
  const name = String(username ?? '').trim()
  const pass = String(password ?? '')
  if (name === '' || pass === '') return { ok: false, error: '请输入用户名和密码' }
  if (name.length > 32 || pass.length > 64) return { ok: false, error: '用户名或密码过长' }
  const answer = await remoteLogin(name, pass)
  if (answer.network) return { ok: false, network: true, error: '无法连接账号服务，请检查网络' }
  if (!answer.ok) return { ok: false, error: answer.error ?? '用户名或密码错误' }
  return keep(answer.account)
}

/**
 * Pull the balances of the signed-in account from the cloud (admin top-ups and
 * other clients' spends land here) and push this device's recorded spends.
 * Returns `{ ok, account }`, or `{ ok: false }` without changing anything when
 * the cloud could not be reached or the account is gone.
 */
export async function syncAccountPoints() {
  const session = loadSession()
  if (typeof session?.username !== 'string' || session.username === '') return { ok: false, error: '未登录' }
  // The cloud counts spends by this watermark: a batch keeps its id until the answer
  // came through, so a resend never deducts twice.
  const spendMaxId = Number(session.pendingMaxId ?? session.spendMaxId ?? 0)
  const answer = await postJson('/api/client/points_sync', {
    users: [{ username: session.username, spend_max_id: spendMaxId, spend: session.spendPending ?? {} }],
  })
  if (answer.network) return { ok: false, network: true }
  const entry = answer.data?.users?.[session.username]
  if (!entry?.exists) return { ok: false, error: '账号不存在' }
  const points = {}
  for (const key of POINT_KEYS) points[key] = Math.trunc(Number(session.points?.[key] ?? 0)) || 0
  for (const key of POINT_KEYS) {
    if (entry.balances?.[key] !== undefined) points[key] = Math.trunc(Number(entry.balances[key] ?? 0)) || 0
  }
  const next = {
    ...session,
    points,
    subTextUntil: String(entry.sub_text_until ?? session.subTextUntil ?? ''),
    subAnalysisUntil: String(entry.sub_analysis_until ?? session.subAnalysisUntil ?? ''),
    subBotUntil: String(entry.sub_aibot_until ?? session.subBotUntil ?? ''),
    ...(entry.relay_key === undefined ? {} : { relayKey: String(entry.relay_key) }),
    ...(entry.agent_slots === undefined ? {} : { agentSlots: Math.max(0, Math.trunc(Number(entry.agent_slots) || 0)) }),
    spendPending: {},
    spendMaxId: Math.max(Number(session.spendMaxId ?? 0), spendMaxId),
  }
  delete next.pendingMaxId
  saveSession(next)
  return { ok: true, account: { username: session.username, points, subTextUntil: next.subTextUntil, subAnalysisUntil: next.subAnalysisUntil } }
}

/**
 * Record a local consumption to push at the next sync. The amounts follow the
 * cloud's sign: negative numbers spend. (The chat turns do not charge yet;
 * this carries the protocol until the pricing is wired.)
 */
export function recordSpend(spend) {
  const session = loadSession()
  if (typeof session?.username !== 'string' || session.username === '') return false
  const pending = { ...(session.spendPending ?? {}) }
  let any = false
  for (const [key, value] of Object.entries(spend ?? {})) {
    if (!POINT_KEYS.includes(key)) continue
    const amount = Math.trunc(Number(value))
    if (!Number.isFinite(amount) || amount >= 0) continue
    pending[key] = (pending[key] ?? 0) + amount
    any = true
  }
  if (!any) return false
  // The first spend of a batch mints the watermark; the batch keeps it until the
  // sync confirmed it, so a lost answer still cannot deduct twice.
  const first = !Object.values(session.spendPending ?? {}).some(value => Number(value) < 0)
  const pendingMaxId = first
    ? Math.max(Number(session.spendMaxId ?? 0) + 1, Date.now())
    : Number(session.pendingMaxId ?? session.spendMaxId ?? 0)
  saveSession({ ...session, spendPending: pending, pendingMaxId })
  return true
}

/** The account as the page and the menu see it. */
export function accountState() {
  const session = loadSession()
  if (typeof session?.username !== 'string' || session.username === '') return { authed: false }
  return {
    authed: true,
    username: session.username,
    points: { ...session.points },
    subTextUntil: session.subTextUntil ?? '',
    subAnalysisUntil: session.subAnalysisUntil ?? '',
    subBotUntil: session.subBotUntil ?? '',
    relayKey: session.relayKey ?? '',
    agentSlots: Math.max(0, Math.trunc(Number(session.agentSlots ?? 0))),
    isAdmin: session.isAdmin === true,
    plan: planState(session),
  }
}

/** Sign out on this device (the cloud account itself is untouched). */
export function logoutAccount() {
  const session = loadSession()
  saveSession(session?.deviceId ? { deviceId: session.deviceId } : {})
}

// The test double of the cloud imports these to see the wire format.
export const ACCOUNT_TEST = { POINT_KEYS, TRIAL_TOTAL, sessionFile }
