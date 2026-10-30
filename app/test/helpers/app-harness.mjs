// The main process of the app, with the Electron parts as a test double: the window, the
// tray and the Host, without a display, without DSH and without the data of the user.
// The loader (test/helpers/loader.mjs) puts the test doubles in place of "electron".
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths, state } from './fake-electron.mjs'
import { hold } from './fake-host-process.mjs'

/** Wait until the app has done something, so that the test does not guess a moment. */
export const waitFor = async (check, what, timeout = 10_000) => {
  const until = Date.now() + timeout
  for (;;) {
    if (check()) return
    if (Date.now() > until) throw new Error(`the app did not ${what}`)
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

/**
 * Start the app on throwaway folders: the places are chosen already and the one-time notice
 * is answered, so that the app asks nothing. The Host answers when the test lets it.
 * @param {{ packaged?: boolean }} options whether the app is a packaged one, with an updater
 */
export const startApp = async ({ packaged = true } = {}) => {
  const home = mkdtempSync(join(tmpdir(), '66ai-bot-main-home-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(paths.userData, { recursive: true })
  writeFileSync(join(paths.userData, 'locations.json'), JSON.stringify({ dataDir: home, workspace }))
  writeFileSync(join(paths.userData, 'tray-close-acknowledged'), '')
  // A signed-in account with the plan the paywall asks for: the gate walks straight in.
  // The account service points at a dead local port, so the balance sync can only keep
  // the last known balances.
  writeFileSync(join(home, 'account.json'), JSON.stringify({
    username: 'tester',
    points: { image: 0, video: 0, text: 100, analysis: 0, app: 0, universal: 0 },
    subTextUntil: '9999-12-31', subAnalysisUntil: '9999-12-31',
  }))
  process.env.CM_BASE_URL = 'http://127.0.0.1:1'
  hold()
  await import('../../src/main.mjs')
  // The app is a packaged one, so that it has an updater. The flag comes after the start,
  // because a packaged app starts on the canonical path of its own.
  state.packaged = packaged
  return { home, workspace }
}

/** The window of the app: the last one it built. */
export const window = () => state.windows.at(-1)

/** The entries of the tray's menu: Open, a line, Quit. */
export const trayMenu = () => state.tray.menu.template
