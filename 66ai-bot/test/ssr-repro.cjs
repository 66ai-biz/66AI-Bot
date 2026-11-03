// SSR repro: render SettingsDialog outside the browser to catch the #130 element-type
// error with a readable stack. Browser globals are stubbed in the banner.
const { createElement: h } = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { SettingsDialog } = require('./settings-bundle.cjs')

const nofn = () => undefined
const actions = new Proxy({}, { get: (t, k) => {
  if (k === 'providers') return undefined
  return t[k] ?? nofn
} })
const roster = { byId: {}, roomsById: {}, bots: [], rooms: [], mains: [] }
const useSel = initial => selector => selector(initial)
const props = {
  page: 'channels', id: undefined, roster, actions, leaving: false,
  useUpdate: useSel(null),
}

function tryPage(page) {
  const p = { ...props, page }
  try {
    const html = renderToStaticMarkup(h(SettingsDialog, p))
    console.log(`page=${page}: OK (${html.length} bytes)`)
    return true
  } catch (error) {
    console.log(`page=${page}: CRASH`)
    console.log(error?.message?.slice(0, 400))
    const frames = String(error?.stack ?? '').split('\n').filter(l => l.includes('settings-bundle') || l.includes('channels-page') || l.includes('assets-page') || l.includes('client-pages')).slice(0, 8)
    console.log(frames.join('\n'))
    return false
  }
}

let allOk = true
for (const page of ['general', 'channels', 'assets', 'projects', 'bots', 'schedules']) {
  if (!tryPage(page)) allOk = false
}
console.log(allOk ? 'ALL PAGES RENDER OK' : 'REPRODUCED: at least one page crashed')
process.exit(0)
