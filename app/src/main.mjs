// Electron main process: one window for the Bot team, served by the app's own DSH Host.
// The window loads the Host's loopback address as DSH Web does: DSH's sign-in sends the page's
// origin as the address the browser comes back to, and accepts only a loopback one.
import { app, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, session, shell as electronShell, Tray } from 'electron'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import electronUpdater from 'electron-updater'
import { BotBrowserGuests, partitionOf } from './bot-browser.mjs'
import { BotViews, isBotId } from './bot-views.mjs'
import { importFromBrowser, listSources } from './browser-sources.mjs'
import { applyCookies, CookieImports } from './cookie-import.mjs'
import { parseCookieFile } from './cookie-parse.mjs'
import { downloadSaver } from './downloads.mjs'
import { canonicalExecPath } from './canonical-path.mjs'
import { chooseLocations, localeText, programFolder, saveLocations, text } from './first-run.mjs'
import { hostPort } from './host-port.mjs'
import { HostProcess } from './host-process.mjs'
import { copySessions, findTeam, importTeam, teamInUse, userDshHome } from './import.mjs'
import { copyData, moveProblem } from './move-data.mjs'
import { CHECK_PROFILE, PROFILE } from './profile.mjs'
import { createShell, SHELL_TEXT } from './shell.mjs'
import { UPDATE_TEXT, watchReleases, watchUpdates } from './updates.mjs'
import { createDeferredPrompt } from './update-prompt.mjs'
import { accountState, configureAccount, loginAccount, logoutAccount, planState, syncAccountPoints } from './auth.mjs'
import { LOGIN_PAGE_URL } from './login-page.mjs'
import { INTRO_PAGE_URL, paywallPageUrl } from './welcome-page.mjs'
import { CAPTION_HEIGHT, cssColor, micaAvailable, nativeThemeSource } from './window-frame.mjs'

const IPC = {
  caption: '66ai-bot:caption-colors', nativeTheme: '66ai-bot:native-theme', fullscreen: '66ai-bot:fullscreen',
  dataLocation: '66ai-bot:data-location', moveData: '66ai-bot:move-data', teamWorkspace: '66ai-bot:team-workspace',
  browserAcquire: '66ai-bot:browser-acquire', browserRelease: '66ai-bot:browser-release', browserForget: '66ai-bot:browser-forget',
  browserViewChanged: '66ai-bot:browser-view-changed', browserViewCreate: '66ai-bot:browser-view-create',
  browserViewSync: '66ai-bot:browser-view-sync', browserViewPlace: '66ai-bot:browser-view-place',
  browserViewNavigate: '66ai-bot:browser-view-navigate', browserViewCommand: '66ai-bot:browser-view-command',
  browserViewFocus: '66ai-bot:browser-view-focus', browserViewRead: '66ai-bot:browser-view-read',
  browserViewClose: '66ai-bot:browser-view-close', browserViewHold: '66ai-bot:browser-view-hold',
  browserImportSources: '66ai-bot:browser-import-sources', browserImportPick: '66ai-bot:browser-import-pick',
  browserImportLive: '66ai-bot:browser-import-live', browserImportApply: '66ai-bot:browser-import-apply',
  browserImportCancel: '66ai-bot:browser-import-cancel',
  appUpdateState: '66ai-bot:app-update-state', appUpdateCheck: '66ai-bot:app-update-check',
  appUpdateInstall: '66ai-bot:app-update-install', appUpdateOpen: '66ai-bot:app-update-open',
  appUpdateChanged: '66ai-bot:app-update-changed',
  authState: '66ai-bot:auth-state', authLogin: '66ai-bot:auth-login',
  authLogout: '66ai-bot:auth-logout', accountChanged: '66ai-bot:account-changed',
  authShowLogin: '66ai-bot:auth-show-login', authOpen: '66ai-bot:auth-open', authCheckPlan: '66ai-bot:auth-check-plan',
}
// A cookie export larger than this is not a cookie export.
const IMPORT_FILE_MAX = 32 * 1024 * 1024
const MOVE_PROBLEMS = { drive: 'moveDrive', nested: 'moveNested', workspace: 'moveWorkspace', program: 'inProgram', notEmpty: 'moveNotEmpty' }
const UPDATE_CHECK_WAIT_MS = 15_000
const UPDATE_DOWNLOAD_WAIT_MS = 15 * 60_000

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')
// Drawn by scripts/icon.mjs. Windows takes the .ico for its several sizes.
const iconFile = join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
// The tray icon of this platform: Windows takes the .ico, macOS the template and its @2x,
// Linux the plain png.
const trayIconFile = () => join(assets, process.platform === 'win32' ? 'tray.ico' : process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
// Windows 11 draws Mica behind the page; mica.css lets it through the sidebar.
const mica = micaAvailable(process.platform, release())
if (process.env.AIBOT_SHELL_DATA) app.setPath('userData', process.env.AIBOT_SHELL_DATA)

let mainWindow
let host
// The Host's loopback origin, which the window loads.
let origin
let hostStop
let updates
let stopping = false
let stopped = false
let failed = false
let places
// The Host answered and the window may talk to it without the launch URL.
let hostReady = false
// The Host's launch URL: the first window trades it for the Host's cookie.
let launchUrl
// The first load of the Host, which mints that cookie. It ends when the first load came
// through (true) or when it never did (false).
let bootstrap
// The launch URL is good for one use only: once a browser has carried it, no browser
// carries it again.
let tokenSpent = false
// The download handler of the app's session is bound once, not once per window.
let downloadsBound = false
// The 66AI account gate: the promise that the sign-in page waits on, and the
// periodic balance sync.
let accountGateResolve
let accountSyncTimer
// Quitting while a first-run dialog is open stops the first run, and during the copy (of the
// first run or of a data move) it waits for the copy to stop at a safe point, so that it leaves
// no half team and no temporary copy.
let choosing
let copying
const copyAbort = new AbortController()
const browserGuests = new BotBrowserGuests({ session, origin: () => origin, devTools: !app.isPackaged })
const botViews = new BotViews({
  window: () => mainWindow, WebContentsView, guests: browserGuests, origin: () => origin, devTools: !app.isPackaged,
  statePath: join(app.getPath('userData'), 'bot-views.json'),
  onChange: state => mainWindow?.webContents.send(IPC.browserViewChanged, state),
})
const cookieImports = new CookieImports()

// The window and the tray: closing the window hides it, the tray is the way back to it and
// the tray's Quit is the one ordinary way out.
const shell = createShell({
  electron: { app, Menu, Tray, powerMonitor },
  platform: process.platform,
  messages: () => localeText(SHELL_TEXT),
  trayImage: () => trayImage(),
  window: () => mainWindow,
  build: () => rebuildWindow(),
  reveal: (target) => {
    if (failed) return
    // macOS: the application menu's Hide hides the app itself, so it comes back first.
    if (process.platform === 'darwin') app.show()
    target.show()
    target.focus()
  },
  quit: () => { app.quit() },
  busy: () => choosing !== undefined || copying !== undefined,
  // Before the first run has chosen its places there is no window to show, and before the
  // first load of the Host there is no address to load.
  ready: () => places !== undefined && origin !== undefined && bootstrap !== undefined,
  notice: { marker: () => join(app.getPath('userData'), 'tray-close-acknowledged'), show: (options) => dialog.showMessageBox(options) },
  // Without a tray the close asks whether the app should end.
  fallback: { show: (options) => dialog.showMessageBox(options) },
})
// The tray icon goes away with the app, and a late answer to the close notice hides nothing.
app.once('will-quit', () => { shell.dispose(); botViews.dispose(); updates?.stop() })

// A packaged app started through an 8.3 short path or a junction restarts once on the
// canonical path: the lock below and every path the Host sees then agree with the long
// form, and the profile patch layer stops mixing the two.
const canonical = app.isPackaged ? canonicalExecPath(process.execPath) : undefined
if (canonical !== undefined) {
  app.relaunch({ execPath: canonical, args: process.argv.slice(1) })
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => { shell.open() })
  app.on('before-quit', (event) => {
    if (choosing !== undefined) {
      // A first-run dialog is open: the quit waits for it, and the app goes on meanwhile.
      event.preventDefault()
      shell.cancelQuit()
      choosing.abort()
      return
    }
    if (copying !== undefined) {
      // A copy is under way: it stops at a safe point, and the app goes on meanwhile.
      event.preventDefault()
      shell.cancelQuit()
      if (copyAbort.signal.aborted) return
      copyAbort.abort()
      void copying.finally(() => { copying = undefined; app.quit() })
      return
    }
    // The app is on its way out: the window may close for good.
    shell.beginQuit()
    if (stopped || host === undefined) return
    event.preventDefault()
    // The Host is already stopping: the quit follows it.
    if (stopping) { void (hostStop ?? Promise.resolve()).then(() => { app.quit() }); return }
    void stopHost().then(() => { app.quit() })
  })
  app.whenReady().then(async () => { shell.install(); await start() }).catch(fail)
}

function stopHost() {
  stopping = true
  hostStop ??= (host?.stop() ?? Promise.resolve()).catch((error) => { console.error(error) }).finally(() => { stopped = true })
  return hostStop
}

async function start() {
  choosing = new AbortController()
  const where = await chooseLocations(choosing.signal).finally(() => { choosing = undefined })
  if (where.quit) { app.exit(0); return }
  places = { dataDir: where.dataDir, workspace: where.workspace }
  // The account session lives next to the app's data; the bridge answers from here on.
  configureAccount({ dataDir: where.dataDir })
  registerAccountIpc()
  // A saved session's relay key lands before the Host spawns, so the model preset
  // reads it on the very first boot.
  syncRelayKeyFile()
  const port = await hostPort(join(app.getPath('userData'), 'host-port.json'))
  origin = `http://127.0.0.1:${String(port)}`
  const pnpm = join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  const profileDir = join(where.dataDir, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  const newHost = () => new HostProcess({
    entry: join(here, 'host.mjs'),
    cwd: profileDir,
    env: { ...process.env, DSH_HOME: where.dataDir, AIBOT_PORT: String(port), AIBOT_APP: '1', AIBOT_USER_DSH_HOME: userDshHome(), AIBOT_RUNTIME_DIR: app.isPackaged ? process.resourcesPath : join(here, '..', 'build', 'runtime'), ...(where.workspace ? { AIBOT_WORKSPACE: where.workspace } : {}) },
    pnpm,
    onFailure: fail,
  })
  // A failed check is not a failed start: start() rejects, and the copy goes on unchecked.
  const newCheck = (home, list) => {
    const cwd = join(home, 'profiles', CHECK_PROFILE)
    mkdirSync(cwd, { recursive: true })
    return new HostProcess({ entry: join(here, 'host.mjs'), cwd, env: { ...process.env, DSH_HOME: home, AIBOT_CHECK: list }, pnpm, onFailure: () => {} })
  }
  const ready = (async () => {
    let copied
    if (where.import) {
      copying = copyTeam(where, newHost, newCheck, copyAbort.signal)
      copied = await copying
      copying = undefined
    }
    if (copied === 'quit') app.exit(0)
    // The window may be waiting for the Host; it goes away with the app.
    if (copied !== undefined) return new Promise(() => {})
    // Not during the import, which a restart would cut short; before the Host, so that an
    // update can still come when this version's Host does not start.
    updates = startUpdates()
    updates?.subscribe((state) => { mainWindow?.webContents.send(IPC.appUpdateChanged, state) })
    host = newHost()
    host.onMessage(message => {
      if (message?.type !== '66ai-bot:browser-endpoint' || typeof message.id !== 'string' || !isBotId(message.botId)) return
      const downloadRoots = message.downloadRoots
      if (!Array.isArray(downloadRoots) || downloadRoots.length > 4 || !Array.from(downloadRoots).every(root => typeof root === 'string' && isAbsolute(root))) {
        host?.send({ type: '66ai-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' })
        return
      }
      void botViews.endpoint(message.botId, { downloadRoots }).then(url => {
        host?.send({ type: '66ai-bot:browser-endpoint-response', id: message.id, url })
      }).catch(() => host?.send({ type: '66ai-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' }))
    })
    return host.start()
  })()
  ready.catch(fail)
  // A throwaway run (AIBOT_HOME) keeps its folders where it was told.
  const fixed = Boolean(process.env.AIBOT_HOME)
  ipcMain.handle(IPC.dataLocation, (event) => {
    assertWindow(event)
    return { path: places.dataDir, fixed }
  })
  ipcMain.handle(IPC.moveData, (event, workspace) => {
    assertWindow(event)
    return fixed ? false : moveData(typeof workspace === 'string' && isAbsolute(workspace) ? workspace : places.workspace)
  })
  // 66ai-bot's Bot browsers: one webview per lease, in the storage of the Bot's key.
  ipcMain.handle(IPC.browserAcquire, (event, key) => {
    assertWindow(event)
    return browserGuests.acquire(event.sender, key)
  })
  ipcMain.handle(IPC.browserRelease, (event, lease) => {
    assertWindow(event)
    return browserGuests.release(event.sender, lease)
  })
  ipcMain.handle(IPC.browserForget, (event, key) => {
    assertWindow(event)
    const botId = typeof key === 'string' && key.startsWith('bot:') ? key.slice(4) : ''
    return Promise.resolve(botId === '' ? undefined : botViews.forget(botId)).then(() => browserGuests.forget(event.sender, key))
  })
  ipcMain.handle(IPC.browserViewCreate, (event, botId, tabId, url) => {
    assertWindow(event)
    return botViews.create(String(botId), { tabId: String(tabId), ...(typeof url === 'string' && url !== '' ? { url } : {}) }).tabId
  })
  ipcMain.handle(IPC.browserViewSync, (event, botId) => {
    assertWindow(event)
    return botViews.sync(String(botId))
  })
  ipcMain.handle(IPC.browserViewPlace, (event, tabId, rect, visible) => { assertWindow(event); return botViews.place(String(tabId), rect, visible === true) })
  ipcMain.handle(IPC.browserViewNavigate, (event, botId, tabId, url) => { assertWindow(event); return botViews.operate(String(botId), 'navigate', { tabId: String(tabId), url }) })
  ipcMain.handle(IPC.browserViewCommand, (event, botId, tabId, command) => { assertWindow(event); return botViews.operate(String(botId), 'command', { tabId: String(tabId), command }) })
  ipcMain.handle(IPC.browserViewFocus, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'focus', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewRead, (event, botId, tabId, script) => { assertWindow(event); return botViews.operate(String(botId), 'read', { tabId: String(tabId), script }) })
  ipcMain.handle(IPC.browserViewClose, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'close', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewHold, (event, botId, held) => { assertWindow(event); return botViews.hold(String(botId), held === true) })
  // Cookie imports: a file or an installed browser's profile is parsed or harvested into a
  // pending set first; only apply (the user's confirm) writes into the Bot's partition.
  ipcMain.handle(IPC.browserImportSources, (event) => {
    assertWindow(event)
    return listSources()
  })
  ipcMain.handle(IPC.browserImportPick, async (event) => {
    assertWindow(event)
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Cookie files', extensions: ['txt', 'json', 'cookies'] }, { name: 'All files', extensions: ['*'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    const buffer = await readFile(picked.filePaths[0])
    if (buffer.length > IMPORT_FILE_MAX) return { error: 'too-large' }
    const parsed = parseCookieFile(buffer)
    if (!parsed.ok) return { error: parsed.error ?? 'unreadable', format: parsed.format }
    return cookieImports.store(parsed, { kind: 'file', label: basename(picked.filePaths[0]) })
  })
  ipcMain.handle(IPC.browserImportLive, async (event, sourceId, close) => {
    assertWindow(event)
    const source = (await listSources()).find((item) => item.id === sourceId)
    if (!source) throw new Error('66AI Bot: an unknown browser profile')
    let outcome
    try {
      outcome = await importFromBrowser(source, { close: close === true })
    } catch (error) {
      if (error?.code === 'app-bound') return { error: 'app-bound' }
      throw error
    }
    if (outcome.running) return { running: true, label: source.label, kind: source.kind }
    const result = {
      format: 'live', entries: outcome.result.cookies.length + outcome.result.skipped.length,
      cookies: outcome.result.cookies, skipped: outcome.result.skipped, warnings: [], info: {},
    }
    return { ...cookieImports.store(result, { kind: source.kind, label: source.label }), restarted: outcome.restarted }
  })
  ipcMain.handle(IPC.browserImportApply, async (event, key, id) => {
    assertWindow(event)
    if (typeof key !== 'string' || !key.startsWith('bot:')) throw new Error('66AI Bot: a Bot storage key is required')
    const pending = cookieImports.take(typeof id === 'string' ? id : '')
    if (!pending) throw new Error('66AI Bot: this import is no longer pending')
    const storage = session.fromPartition(partitionOf(key))
    return applyCookies(storage, pending.cookies)
  })
  ipcMain.handle(IPC.browserImportCancel, (event, id) => {
    assertWindow(event)
    if (typeof id === 'string') cookieImports.drop(id)
  })
  // The app's own update state, for the About row. `updates` exists once the ready block
  // created it; before that (and in runs without an updater) the state is null.
  ipcMain.handle(IPC.appUpdateState, (event) => {
    assertWindow(event)
    return updates?.state() ?? null
  })
  ipcMain.handle(IPC.appUpdateCheck, (event) => {
    assertWindow(event)
    updates?.check()
  })
  ipcMain.handle(IPC.appUpdateInstall, async (event) => {
    assertWindow(event)
    if (updates?.state().phase === 'downloaded') await updates.install()
  })
  ipcMain.handle(IPC.appUpdateOpen, (event) => {
    assertWindow(event)
    const state = updates?.state()
    if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
      void electronShell.openExternal(state.page)
    }
  })
  // The plugin keeps the team workspace; the app remembers it for its own checks.
  ipcMain.on(IPC.teamWorkspace, (event, path) => {
    if (fixed || !fromWindow(event) || typeof path !== 'string' || !isAbsolute(path)) return
    places = { ...places, workspace: path }
    saveLocations(places)
  })
  if (process.platform === 'win32') {
    // Windows ignores the alpha of the caption buttons' color, so they take the opaque color
    // of the surface under them, which the page measures.
    ipcMain.on(IPC.caption, (event, color, symbolColor) => {
      if (fromWindow(event) && cssColor(color) && cssColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
    // Mica and the caption buttons follow the app's theme, not only the system's.
    ipcMain.on(IPC.nativeTheme, (event, source) => {
      const value = nativeThemeSource(source)
      if (fromWindow(event) && value !== undefined) nativeTheme.themeSource = value
    })
  }

  setMenu()
  // A packaged app has the icon in its bundle; Electron's own run shows Electron's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile)
  createWindow()
  // The launch URL trades its token for the Host's cookie and goes on to the page. The cookie
  // is there once that load came through. The token is good for one browser only: it is spent
  // as soon as a window carries it.
  bootstrap = (async () => {
    const { url } = await ready
    launchUrl = url
    const win = mainWindow
    if (win === undefined) return false
    // The 66AI account gate: without a signed-in account the window stays on the
    // sign-in page, or stays on the paywall until the account holds the plan.
    await gateAccount(win)
    if (win.isDestroyed()) return false
    tokenSpent = true
    await win.loadURL(url)
    hostReady = true
    return true
  })().catch(() => false)
}

// ---------------------------------------------------------------------------
// The 66AI account

const ACCOUNT_SYNC_INTERVAL_MS = 5 * 60_000

const accountViewState = () => {
  const state = accountState()
  return state.authed
    ? { ...state, plan: planState(state) }
    : { authed: false }
}

// The subscription facts the paywall names: when the 138-yuan 66AI Bot plan runs out.
function paywallText() {
  const state = accountState()
  const plan = state.plan ?? {}
  const untilText = (plan.subBotUntil || '') !== ''
    ? `66AI Bot 套餐至 ${plan.subBotUntil}`
    : '暂无'
  return { username: state.username ?? '', untilText }
}

// The entitlements the cloud handed the signed-in account, parked where the Host's
// plugins read them (the app's data dir = DSH_HOME): the relay key for the built-in
// 66ai provider and the agent slots the plan grants. A logout clears the key and
// zeroes the slots with the session.
function syncRelayKeyFile() {
  if (places === undefined) return
  try {
    const state = accountState()
    const authed = state.authed === true
    const key = authed ? String(state.relayKey ?? '') : ''
    const slots = authed ? Math.max(0, Math.trunc(Number(state.agentSlots ?? 0))) : 0
    if (key === '') rmSync(join(places.dataDir, 'preset-key.local'), { force: true })
    else writeFileSync(join(places.dataDir, 'preset-key.local'), `${JSON.stringify({ key })}\n`)
    writeFileSync(join(places.dataDir, 'agent-limit.local'), `${JSON.stringify({ slots })}\n`)
  } catch (error) {
    console.error('66AI Bot: could not store the account entitlements', error)
  }
}

// The gate walks through the app's own pages until the account may in: the product
// introduction (which links to the unified sign-up) for the unsigned, then the paywall
// for a signed-in account without the required plan. A signed-in account re-checks the
// cloud once before the Host opens (a short timeout; the cached plan stands in when the
// service cannot be reached), so an expired plan cannot ride a saved session in.
async function gateAccount(win) {
  let view = accountViewState()
  if (view.authed) {
    const answer = await Promise.race([
      syncAccountPoints().catch(() => ({ ok: false, network: true })),
      new Promise((resolve) => { const timer = setTimeout(() => resolve({ ok: false, network: true }), 3_000); timer.unref?.() }),
    ])
    if (answer?.ok === true) {
      syncRelayKeyFile()
      view = accountViewState()
    }
  }
  if (view.authed && view.plan?.allowed === true) {
    startAccountSync()
    return
  }
  if (accountGateResolve !== undefined) {
    return new Promise((resolve) => {
      const previous = accountGateResolve
      accountGateResolve = () => { previous?.(); resolve() }
    })
  }
  const page = view.authed ? paywallPageUrl(paywallText()) : INTRO_PAGE_URL
  return win.loadURL(page).then(() => new Promise((resolve) => { accountGateResolve = resolve }))
    .catch((error) => { console.error('66AI Bot: the account page could not be shown', error) })
    .finally(() => { accountGateResolve = undefined })
}

function resolveAccountGate() {
  startAccountSync()
  const resolve = accountGateResolve
  accountGateResolve = undefined
  resolve?.()
  mainWindow?.webContents?.send?.(IPC.accountChanged, accountViewState())
}

// The balances follow the cloud: admin top-ups and other clients' spends land here.
async function refreshAccount() {
  if (!accountViewState().authed) return
  const answer = await syncAccountPoints()
  if (!answer.ok && answer.network) return
  syncRelayKeyFile()
  mainWindow?.webContents?.send?.(IPC.accountChanged, accountViewState())
}

function startAccountSync() {
  if (accountSyncTimer !== undefined) return
  // unref: the app lives on its windows and tray, not on these timers (and a test
  // process can end with them standing).
  setTimeout(() => { void refreshAccount().catch((error) => { console.error(error) }) }, 4_000).unref?.()
  accountSyncTimer = setInterval(() => { void refreshAccount().catch((error) => { console.error(error) }) }, ACCOUNT_SYNC_INTERVAL_MS)
  accountSyncTimer.unref?.()
}

// The sign-in page is the app's own, so the sender check is the guard; the host
// pages keep the stricter assertWindow wherever they talk to the app.
const fromOwnWindow = (event) => event.sender === mainWindow?.webContents

function registerAccountIpc() {
  ipcMain.handle(IPC.authState, (event) => {
    if (!fromOwnWindow(event)) return { authed: false }
    return accountViewState()
  })
  ipcMain.handle(IPC.authLogin, async (event, payload) => {
    if (!fromOwnWindow(event)) return { ok: false, error: 'rejected' }
    const result = await loginAccount(payload?.username, payload?.password)
    if (result.ok) syncRelayKeyFile()
    if (result.ok && !planState().allowed) {
      // A signed-in account without the plan stays at the gate: the paywall names it.
      await mainWindow?.loadURL?.(paywallPageUrl(paywallText()))
      return result
    }
    if (result.ok) resolveAccountGate()
    return result
  })
  ipcMain.handle(IPC.authLogout, (event) => {
    if (!fromOwnWindow(event)) return { ok: false }
    logoutAccount()
    syncRelayKeyFile()
    // A fresh run asks for the account again at the gate.
    setTimeout(() => { app.relaunch(); app.exit(0) }, 300)
    return { ok: true }
  })
  ipcMain.handle(IPC.authShowLogin, (event) => {
    if (!fromOwnWindow(event)) return { ok: false }
    void mainWindow?.loadURL?.(LOGIN_PAGE_URL).catch((error) => { console.error(error) })
    return { ok: true }
  })
  // The unified account site is the one place accounts are registered and plans bought.
  ipcMain.handle(IPC.authOpen, (event, url) => {
    if (!fromOwnWindow(event)) return { ok: false }
    if (url !== 'https://cm.66ai.biz/pay' && url !== 'https://cm.66ai.biz/register') return { ok: false, error: 'rejected' }
    void electronShell.openExternal(url).catch((error) => { console.error(error) })
    return { ok: true }
  })
  ipcMain.handle(IPC.authCheckPlan, async (event) => {
    if (!fromOwnWindow(event)) return { ok: false, error: 'rejected' }
    // Pull the subscriptions as the cloud sees them now, then re-judge.
    const synced = await syncAccountPoints()
    if (synced.network) return { ok: false, network: true }
    if (synced.ok !== true) return { ok: false, error: '账号状态确认失败，请重新登录后再试' }
    syncRelayKeyFile()
    const state = planState()
    if (state.allowed) resolveAccountGate()
    return { ok: state.allowed }
  })
}

// The Host starts once on the new data location first: DSH then sets up its project list
// without the copied Sessions' folders, so the old team's folders are not offered as projects.
// Before that, the app's own DSH reads every chat of the team once: a newer DSH can write
// records that this one refuses while the log format stays the same. Such a chat stops the
// copy, as a newer log format does; 'quit' means the user updates 66AI Bot first, and
// 'stopped' that the app quit during the copy.
async function copyTeam(where, newHost, newCheck, signal) {
  const unreadable = await checkTeam(where, newCheck, signal)
  if (signal.aborted) return 'stopped'
  if (unreadable > 0) {
    const t = text()
    const { response } = await dialog.showMessageBox({ type: 'warning', title: '66AI Bot', noLink: true, message: t.newer(unreadable), buttons: [t.quit, t.startEmpty], defaultId: 0, cancelId: 0, signal })
    if (signal.aborted) return 'stopped'
    if (response === 0) return 'quit'
    saveLocations(where)
    return undefined
  }
  const warm = newHost()
  host = warm
  const stopWarm = () => { void warm.stop() }
  signal.addEventListener('abort', stopWarm, { once: true })
  try {
    await warm.start()
    if (signal.aborted) return 'stopped'
    mainWindow?.setProgressBar(2)
    await warm.stop()
    host = undefined
    const summary = await importTeam({ ...where.import, to: where.dataDir, workspace: where.workspace, dsh: getDshRuntimeVersion(), signal })
    console.log(`66AI Bot: copied ${String(summary.bots)} Bots and ${String(summary.sessions)} Sessions from ${summary.from}`)
  } catch (error) {
    if (signal.aborted) return 'stopped'
    console.error(error)
    await dialog.showMessageBox({ type: 'warning', title: '66AI Bot', message: text().failed(error instanceof Error ? error.message : String(error)), signal })
    if (signal.aborted) return 'stopped'
  } finally {
    signal.removeEventListener('abort', stopWarm)
    mainWindow?.setProgressBar(-1)
  }
  saveLocations(where)
  return undefined
}

// A copy of the chats in a DSH home of its own, so that nothing of the check stays in the data.
async function checkTeam(where, newCheck, signal) {
  // A run that was killed can leave its temporary check home behind.
  for (const name of readdirSync(where.dataDir).filter(entry => /^\.import-check-\d+$/u.test(entry))) {
    await rm(join(where.dataDir, name), { recursive: true, force: true }).catch((error) => { console.error(error) })
  }
  const home = join(where.dataDir, `.import-check-${String(Date.now())}`)
  try {
    const found = findTeam(where.import.from)
    const ids = found === undefined ? [] : await copySessions(where.import.from, found.team, home, signal)
    if (ids.length === 0) return 0
    mainWindow?.setProgressBar(2)
    const list = join(home, 'check.json')
    writeFileSync(list, JSON.stringify(ids))
    const check = newCheck(home, list)
    const stop = () => { void check.stop() }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      const { unreadable } = await check.start()
      if (unreadable.length > 0) console.warn(`66AI Bot: this DSH cannot read ${unreadable.join(', ')}`)
      return unreadable.length
    } finally {
      signal.removeEventListener('abort', stop)
      await check.stop()
    }
  } catch (error) {
    if (!signal.aborted) console.error('66AI Bot: the chats were not checked before the copy:', error)
    return 0
  } finally {
    mainWindow?.setProgressBar(-1)
    await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  }
}

// The data moves as a copy while the Host is stopped, and the app starts again on the new
// folder; after a failed copy it starts again on the old one. The old folder stays.
async function moveData(workspace) {
  if (copying !== undefined || stopping || mainWindow === undefined) return false
  const t = text()
  const owner = mainWindow
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, { title: t.pickMove, defaultPath: dirname(places.dataDir), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] })
  if (canceled || filePaths[0] === undefined) return false
  const to = resolve(filePaths[0])
  const dshHome = userDshHome()
  // The team workspace can move while a dialog is open; the window tells the latest one.
  const refused = async () => {
    for (const current of new Set([workspace, places.workspace])) {
      const problem = moveProblem({ from: places.dataDir, to, workspace: current, dshHome, program: app.isPackaged ? programFolder() : undefined })
      if (problem === undefined) continue
      await dialog.showMessageBox(owner, { type: 'warning', title: '66AI Bot', message: problem === 'dsh' ? t.inDsh(dshHome) : t[MOVE_PROBLEMS[problem]], buttons: ['OK'] })
      return true
    }
    return false
  }
  if (await refused()) return false
  const { response } = await dialog.showMessageBox(owner, { type: 'question', title: '66AI Bot', noLink: true, message: t.moveConfirm(to), detail: t.moveDetail(places.dataDir), buttons: [t.move, t.cancel], defaultId: 0, cancelId: 1 })
  if (response !== 0 || stopping || await refused()) return false
  const signal = copyAbort.signal
  copying = (async () => {
    // The settings go away first, so that nothing moves the team workspace from here on.
    void mainWindow?.loadURL(notePage(t.moving)).catch(() => {})
    await stopHost()
    // The app may have heard of a team workspace change while the Host stopped.
    if (await refused()) {
      app.relaunch()
      return
    }
    // Another DSH on the same data would go on writing while the copy is made.
    if (teamInUse(places.dataDir)) {
      await dialog.showMessageBox({ type: 'warning', title: '66AI Bot', message: t.moveInUse })
      app.relaunch()
      return
    }
    mainWindow?.setProgressBar(2)
    try {
      await copyData(places.dataDir, to, signal)
      try {
        saveLocations({ dataDir: to, workspace: places.workspace ?? workspace })
      } catch (error) {
        // Unused, the copy would only keep the folder from being chosen again.
        await rm(to, { recursive: true, force: true, maxRetries: 5 }).catch((failure) => { console.error(failure) })
        throw error
      }
    } catch (error) {
      if (signal.aborted) return
      console.error(error)
      await dialog.showMessageBox({ type: 'warning', title: '66AI Bot', message: t.moveFailed(error instanceof Error ? error.message : String(error)) })
    } finally {
      mainWindow?.setProgressBar(-1)
    }
    app.relaunch()
  })()
  await copying
  copying = undefined
  app.quit()
  return true
}

const notePage = message => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<body style="margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;background:Canvas;color:CanvasText">${message.replace(/[&<>]/gu, char => `&#${String(char.charCodeAt(0))};`)}</body>`)}`

// Windows and a Linux AppImage update themselves; macOS and a Linux deb ask to download the new
// version. Throwaway runs check only a given feed and never ask.
function startUpdates() {
  const feed = process.env.AIBOT_UPDATE_URL || undefined
  const throwaway = Boolean(process.env.AIBOT_HOME)
  if (!app.isPackaged || (throwaway && feed === undefined)) return undefined
  if (process.platform === 'darwin') {
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
    })
  }
  // electron-updater's Linux updater works only from inside an AppImage (APPIMAGE is set there);
  // a deb cannot update itself and points at the release page instead, as on macOS. The deb's
  // file name uses the Debian architecture (x64 → amd64).
  if (process.platform === 'linux' && process.env.APPIMAGE === undefined) {
    const debArch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
      asset: version => `66ai-bot-${version}-linux-${debArch}.deb`,
    })
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    // The update ends the app: the window closes for good, and the Host stops before the
    // installer replaces its files.
    return watchUpdates({
      updater: electronUpdater.autoUpdater, feed, ask: throwaway ? undefined : (version) => restartPrompt.prompt(version),
      beforeInstall: () => { shell.beginQuit(); return stopHost() },
    })
  }
  return undefined
}

// A prompt that belongs to a window is not asked while the window is hidden or minimized: it
// waits for the window to be on the screen again.
function windowShown() {
  return mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
}

async function askRestartNow(version) {
  // After a failed start, fail() installs the update itself.
  if (failed) return false
  const t = localeText(UPDATE_TEXT)
  const options = { type: 'info', title: '66AI Bot', message: t.ready(version), detail: t.readyDetail, buttons: [t.restart, t.later], defaultId: 0, cancelId: 1, noLink: true }
  const { response } = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
  return response === 0
}

async function askDownloadNow(version) {
  if (failed) return false
  const t = localeText(UPDATE_TEXT)
  const options = { type: 'info', title: '66AI Bot', message: t.available(version), detail: t.availableDetail, buttons: [t.download, t.later], defaultId: 0, cancelId: 1, noLink: true }
  const { response } = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
  return response === 0
}

// What the updater does when the user says yes. The answer may come later, when the window
// is shown again; then the work is done here.
async function installUpdate() { await updates?.install() }

async function openUpdatePage() {
  const state = updates?.state()
  if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
    await electronShell.openExternal(state.page)
  }
}

const restartPrompt = createDeferredPrompt({ ask: askRestartNow, shown: windowShown, onYes: installUpdate })
const downloadPrompt = createDeferredPrompt({ ask: askDownloadNow, shown: windowShown, onYes: openUpdatePage })

async function flushDeferredUpdate() {
  await restartPrompt.flush()
  await downloadPrompt.flush()
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const win32 = process.platform === 'win32'
  const win = new BrowserWindow({
    // The window never squeezes the chat: RAIL_WIDTH + MIN_CHAT from 66ai-bot's
    // src/client/frame-layout.js is the avatar rail plus the smallest chat column.
    width: 1320, height: 860, minWidth: 508, minHeight: 480,
    title: '66AI Bot', show: false, icon: iconFile,
    backgroundColor: mica ? '#00000000' : dark ? '#1b1b1c' : '#ffffff',
    // Frameless as in DSH Desktop: the caption buttons overlay the page's band. They keep the
    // sidebar's colors until the page sends the colors of the surface under them.
    ...(win32 ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: CAPTION_HEIGHT, color: dark ? '#1b1b1c' : '#f9fafb', symbolColor: dark ? '#f9fafb' : '#0f1115' },
      ...(mica ? { backgroundMaterial: 'mica' } : {}),
    } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true,
      additionalArguments: [`--66ai-bot-origin=${origin}`, ...(win32 ? [`--66ai-bot-caption=${String(CAPTION_HEIGHT)}`, ...(mica ? ['--66ai-bot-mica'] : [])] : [])],
    },
  })
  mainWindow = win
  // A window that the shell has hidden, or that the app is leaving, stays out of sight.
  win.once('ready-to-show', () => {
    if (win.isDestroyed() || shell.isQuitting() || shell.isHidden(win)) return
    win.show()
  })
  win.on('page-title-updated', (event) => { event.preventDefault() })
  win.on('closed', () => {
    if (mainWindow !== win) return
    mainWindow = undefined
    // The Bot browsers' tabs belonged to this window; they wait for the next one.
    botViews.release()
  })
  // The window hides instead of closing; the shell decides when it really goes.
  shell.watch(win)
  browserGuests.bind(win)
  // The tabs that outlived the last window join this one.
  botViews.attach(win)
  const contents = win.webContents
  // The session is the same for every window of the app, so the handler is bound once.
  if (!downloadsBound) {
    downloadsBound = true
    contents.session.on('will-download', downloadSaver({ window: () => mainWindow, dialog, downloads: app.getPath('downloads') }))
  }
  if (win32) {
    // Fullscreen hides the caption buttons, and the page drops its band meanwhile. A reload
    // registers the page's listener again, so the state goes out after every load too.
    const sendFullscreen = () => { if (mainWindow !== undefined) contents.send(IPC.fullscreen, win.isFullScreen()) }
    win.on('enter-full-screen', sendFullscreen)
    win.on('leave-full-screen', sendFullscreen)
    contents.on('did-finish-load', sendFullscreen)
  }
  if (mica) {
    const css = readFileSync(join(here, 'mica.css'), 'utf8')
    contents.on('dom-ready', () => { void contents.insertCSS(css) })
  }
  const fonts = readFileSync(join(here, 'fonts.css'), 'utf8')
  contents.on('dom-ready', () => { void contents.insertCSS(fonts) })
  contents.setWindowOpenHandler(({ url }) => {
    // DSH's sign-in opens a blank window during the click and sends it to the sign-in page later.
    if (url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: true, webviewTag: false } } }
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (child) => {
    const away = (event, url) => {
      if (url === 'about:blank') return
      event.preventDefault()
      openOutside(url)
      child.destroy()
    }
    child.webContents.on('will-navigate', away)
    child.webContents.on('will-redirect', away)
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${origin}/`)) return
    event.preventDefault()
    openOutside(url)
  })
  if (!app.isPackaged) {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
    })
  }
  // The window that is shown again asks for the update that waited for it. A window that was
  // minimized asks for it when it comes back.
  win.on('show', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  win.on('restore', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  void win.loadURL(notePage(text().starting)).catch(() => {})
  return win
}

// The window is gone for good: a new one takes its place and talks to the Host that runs.
function rebuildWindow() {
  const win = createWindow()
  void connectHost(win).catch((error) => { console.error(error) })
  return win
}

// The window talks to the Host that runs. The first one trades the launch URL for the Host's
// cookie; the later ones use the plain address, which that cookie carries. The launch URL is
// used again only when no browser carried it at all, so that a token is never spent twice.
async function connectHost(win) {
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  // The first load of the Host decides how this window comes in.
  if (bootstrap !== undefined) await bootstrap
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  // The first load never came through. The cookie may be there anyway: it belongs to the
  // session of the browser, which outlives the window.
  if (await hostCookie()) {
    hostReady = true
    await win.loadURL(`${origin}/`)
    return
  }
  // There is no cookie: the launch URL is the one way in, and only while it was not used.
  if (launchUrl !== undefined && !tokenSpent) {
    tokenSpent = true
    await win.loadURL(launchUrl)
    hostReady = true
    return
  }
  await win.loadURL(`${origin}/`)
}

// The Host's cookie: the launch URL trades its token for it. The app does not need to know
// its name, only whether the browser holds one for the Host's address.
async function hostCookie() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: `${origin}/` })
    return cookies.length > 0
  } catch (error) {
    console.error(error)
    return false
  }
}

// The mark of the tray: the file of this platform, and on macOS the template that follows the
// colour of the menu bar.
function trayImage() {
  const file = trayIconFile()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) throw new Error(`the tray icon ${file} could not be read`)
  if (process.platform === 'darwin') {
    const retina = nativeImage.createFromPath(join(assets, 'trayTemplate@2x.png'))
    const size = retina.getSize()
    if (!retina.isEmpty() && size.width > image.getSize().width) {
      image.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG(), width: size.width, height: size.height })
    }
    image.setTemplateImage(true)
  }
  return image
}

function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  const t = localeText(SHELL_TEXT)
  // The application menu of macOS, without its Quit: the tray's Quit is the one ordinary way
  // out. Only when the tray is not there does the menu carry one, so that the app can still
  // be ended.
  const items = [
    { role: 'about' },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
  ]
  if (!shell.hasTray()) {
    items.push({ type: 'separator' }, { label: t.quit, click: () => { shell.quit() } })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: items },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
}

function assertWindow(event) {
  const contents = mainWindow?.webContents
  if (contents === undefined || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || !event.senderFrame.url.startsWith(`${origin}/`)) throw new Error('66AI Bot: rejected IPC from an unknown page')
}

function fromWindow(event) {
  try { assertWindow(event); return true } catch { return false }
}

function openOutside(url) {
  if (/^https?:\/\//iu.test(url)) void electronShell.openExternal(url)
}

// A new version may fix what keeps this one from starting.
async function fail(error) {
  console.error(error)
  if (failed || stopping) return
  failed = true
  const found = await Promise.race([updates?.latest() ?? null, sleep(UPDATE_CHECK_WAIT_MS).then(() => null)])
  const throwaway = Boolean(process.env.AIBOT_HOME)
  const t = localeText(UPDATE_TEXT)
  const next = found ? `\n\n${found.page ? t.onFailurePage(found.version) : t.onFailure(found.version)}` : ''
  dialog.showErrorBox('66AI Bot', `${text().notStarted}\n\n${error instanceof Error ? error.message : String(error)}${next}`)
  if (found?.page) {
    if (!throwaway) await electronShell.openExternal(found.page)
    app.quit()
    return
  }
  if (found) {
    mainWindow?.hide()
    if (await Promise.race([found.downloaded, sleep(UPDATE_DOWNLOAD_WAIT_MS).then(() => false)])) {
      await updates.install()
      return
    }
  }
  app.quit()
}
