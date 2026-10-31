// Gives the page that the app's Host serves the app's own bridge. On Windows it also marks the
// page for the frameless window the way DSH Desktop's preload does
// (apps/desktop/src/preload-windows.ts, preload-platform.ts and preload-theme.ts; see NOTICE),
// but without data-platform: that puts DSH's shortcuts on native menu input, which this
// window does not have.
const { contextBridge, ipcRenderer } = require('electron')

const host = process.argv.find(value => value.startsWith('--66ai-bot-origin='))?.slice('--66ai-bot-origin='.length)
if (host !== undefined && location.origin === host) {
  // 66AI Bot's settings show and move the app's data location through this.
  contextBridge.exposeInMainWorld('dsBotApp', {
    dataLocation: () => ipcRenderer.invoke('66ai-bot:data-location'),
    moveData: (workspace) => ipcRenderer.invoke('66ai-bot:move-data', typeof workspace === 'string' ? workspace : undefined),
    teamWorkspaceChanged: (path) => { ipcRenderer.send('66ai-bot:team-workspace', String(path)) },
    // The Bot browsers, in the shape of DSH Desktop's browser bridge so that 66ai-bot drives both
    // alike; `forget` clears a key's storage, which here outlives the app.
    browser: browserBridge(),
    // The app's own updater, for the About row's state and buttons.
    updates: updatesBridge(),
  })
  const caption = process.argv.find(value => value.startsWith('--66ai-bot-caption='))
  if (caption !== undefined) {
    ipcRenderer.on('66ai-bot:fullscreen', (_event, fullscreen) => {
      const root = document.documentElement
      if (root === null) return
      if (fullscreen) root.dataset.fullscreen = 'true'
      else delete root.dataset.fullscreen
    })
    const start = () => { frameless(caption.slice('--66ai-bot-caption='.length), process.argv.includes('--66ai-bot-mica')) }
    // A preload runs before the document root exists.
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true })
    else start()
  }
}

function browserBridge() {
  const listeners = new Map()
  const viewListeners = new Set()
  ipcRenderer.on('66ai-bot:browser-view-changed', (_event, change) => {
    for (const listener of [...viewListeners]) {
      try { listener(change) } catch (error) { console.error('66AI Bot: a browser view listener failed', error) }
    }
  })
  ipcRenderer.on('66ai-bot:browser-open-requested', (_event, request) => {
    if (typeof request?.lease !== 'string' || typeof request.url !== 'string') return
    for (const listener of [...(listeners.get(request.lease) ?? [])]) {
      try { listener(request.url) } catch (error) { console.error('66AI Bot: a browser link handler failed', error) }
    }
  })
  return {
    acquire: key => ipcRenderer.invoke('66ai-bot:browser-acquire', String(key)),
    release: lease => ipcRenderer.invoke('66ai-bot:browser-release', String(lease)),
    forget: key => ipcRenderer.invoke('66ai-bot:browser-forget', String(key)),
    views: {
      create: (botId, tabId, url) => ipcRenderer.invoke('66ai-bot:browser-view-create', String(botId), String(tabId), typeof url === 'string' ? url : undefined),
      sync: botId => ipcRenderer.invoke('66ai-bot:browser-view-sync', String(botId)),
      place: (tabId, rect, visible) => ipcRenderer.invoke('66ai-bot:browser-view-place', String(tabId), rect, visible === true),
      navigate: (botId, tabId, url) => ipcRenderer.invoke('66ai-bot:browser-view-navigate', String(botId), String(tabId), String(url)),
      command: (botId, tabId, command) => ipcRenderer.invoke('66ai-bot:browser-view-command', String(botId), String(tabId), String(command)),
      focus: (botId, tabId) => ipcRenderer.invoke('66ai-bot:browser-view-focus', String(botId), String(tabId)),
      read: (botId, tabId, script) => ipcRenderer.invoke('66ai-bot:browser-view-read', String(botId), String(tabId), String(script)),
      close: (botId, tabId) => ipcRenderer.invoke('66ai-bot:browser-view-close', String(botId), String(tabId)),
      hold: (botId, held) => ipcRenderer.invoke('66ai-bot:browser-view-hold', String(botId), held === true),
      subscribe(listener) { viewListeners.add(listener); return () => viewListeners.delete(listener) },
    },
    // Cookie imports, only in the app: sources and a two-step pick/harvest → preview → apply.
    importSources: () => ipcRenderer.invoke('66ai-bot:browser-import-sources'),
    importPick: () => ipcRenderer.invoke('66ai-bot:browser-import-pick'),
    importLive: (source, close) => ipcRenderer.invoke('66ai-bot:browser-import-live', String(source), close === true),
    importApply: (key, pending) => ipcRenderer.invoke('66ai-bot:browser-import-apply', String(key), String(pending)),
    importCancel: (pending) => ipcRenderer.invoke('66ai-bot:browser-import-cancel', String(pending)),
    onOpenRequested(lease, listener) {
      const id = String(lease)
      let set = listeners.get(id)
      if (set === undefined) { set = new Set(); listeners.set(id, set) }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0 && listeners.get(id) === set) listeners.delete(id)
      }
    },
  }
}

function updatesBridge() {
  const listeners = new Set()
  ipcRenderer.on('66ai-bot:app-update-changed', (_event, state) => {
    for (const listener of [...listeners]) {
      try { listener(state) } catch (error) { console.error('66AI Bot: an update state handler failed', error) }
    }
  })
  return {
    state: () => ipcRenderer.invoke('66ai-bot:app-update-state'),
    check: () => ipcRenderer.invoke('66ai-bot:app-update-check'),
    install: () => ipcRenderer.invoke('66ai-bot:app-update-install'),
    open: () => ipcRenderer.invoke('66ai-bot:app-update-open'),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function frameless(height, mica) {
  const root = document.documentElement
  root.dataset.windowsTitlebar = ''
  root.style.setProperty('--dsh-windows-titlebar-height', `${height}px`)
  // DSH keeps the dialog mask off the caption band, which then stays bright above a dimmed
  // page; here the band is part of the page, so the mask covers it too.
  root.style.setProperty('--dsh-frame-chrome-top', '0px')
  let theme
  const sendTheme = () => {
    const value = root.getAttribute('data-ds-theme-source')
    if (value === null || value === theme) return
    theme = value
    ipcRenderer.send('66ai-bot:native-theme', value)
  }
  new MutationObserver(sendTheme).observe(root, { attributeFilter: ['data-ds-theme-source'] })
  sendTheme()
  captionColors(mica)
}

// The caption buttons stand on the rightmost open column with Mica (the right sidebar or the
// conversation) and on the sidebar-colored band without it. Theme variables can resolve apart
// from what is painted, so the color comes from the element itself: the first one up from it
// that is not transparent.
function captionColors(mica) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return
  const opaque = (color) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
    return alpha === 0 ? undefined : `rgb(${red}, ${green}, ${blue})`
  }
  // The surface's color with the layers above the caption buttons (a dialog's mask) painted over it.
  const covered = (base, frame) => {
    const layers = []
    for (const element of document.elementsFromPoint(innerWidth - 1, 1)) {
      if (frame !== null && (element === frame || element.contains(frame) || frame.contains(element))) break
      for (const pseudo of ['::after', null, '::before']) layers.push(getComputedStyle(element, pseudo).backgroundColor)
    }
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = base
    context.fillRect(0, 0, 1, 1)
    for (const color of layers.reverse()) {
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
    }
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
    return `rgb(${red}, ${green}, ${blue})`
  }
  const column = () => {
    if (!mica) return document.querySelector('div[class*="_sidebarCol"]')
    const right = document.querySelector('div[class*="_rightbarCol"]')
    return right !== null && right.getBoundingClientRect().width > 0 ? right : document.querySelector('div[class*="_centerCol"]')
  }
  let frame
  const surface = () => {
    const start = column()
    // Opening or closing the right sidebar changes the frame's columns.
    if (start !== null && frame === undefined) {
      frame = start.parentElement
      observer.observe(frame, { attributes: true, attributeFilter: ['style'] })
    }
    for (let element = start; element !== null; element = element.parentElement) {
      const color = opaque(getComputedStyle(element).backgroundColor)
      if (color !== undefined) return [covered(color, frame ?? null), opaque(getComputedStyle(element).color)]
    }
    return undefined
  }
  let sent = ''
  let tries = 0
  const send = () => {
    const colors = surface()
    // The frame appears once DSH has booted; until then the main process's colors hold.
    if (colors === undefined || colors[1] === undefined) {
      if (tries++ < 120) setTimeout(send, 250)
      return
    }
    const current = colors.join()
    if (current === sent) return
    sent = current
    ipcRenderer.send('66ai-bot:caption-colors', ...colors)
  }
  // A dialog mounts anywhere in the page, which changes all the time; one look per frame.
  let queued = false
  const queue = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; send() })
  }
  const observer = new MutationObserver(queue)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'], childList: true, subtree: true })
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source', 'style'] })
  // A stylesheet link is added before it loads; its rules apply without another mutation.
  document.head.addEventListener('load', send, true)
  send()
}

// The 66AI account bridge: the sign-in page and the shell's account card talk to the
// app's account service through it. Exposed on every page the window loads (they are
// all the app's own: the Host's shell and the local sign-in page).
contextBridge.exposeInMainWorld('aibotAuth', {
  state: () => ipcRenderer.invoke('66ai-bot:auth-state'),
  login: (username, password) => ipcRenderer.invoke('66ai-bot:auth-login', { username: String(username ?? ''), password: String(password ?? '') }),
  logout: () => ipcRenderer.invoke('66ai-bot:auth-logout'),
  // The introduction page's step into the sign-in form, the sign-up link to the
  // unified account site, and the paywall's re-check after a purchase.
  showLogin: () => ipcRenderer.invoke('66ai-bot:auth-show-login'),
  open: (url) => ipcRenderer.invoke('66ai-bot:auth-open', String(url ?? '')),
  checkPlan: () => ipcRenderer.invoke('66ai-bot:auth-check-plan'),
  onChanged: (listener) => {
    if (typeof listener !== 'function') return
    ipcRenderer.on('66ai-bot:account-changed', (_event, state) => {
      try { listener(state) } catch (error) { console.error('66AI Bot: an account listener failed', error) }
    })
  },
})
