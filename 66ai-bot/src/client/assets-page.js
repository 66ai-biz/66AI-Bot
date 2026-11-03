// The Assets page: every file the team keeps — pictures, videos, audio, documents and
// the rest — in one gallery. Scanned from the team workspace and the project folders;
// previews come from the host under the same guard, so only team folders are readable.
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { CopyIcon, ChevronRightIcon, CloseIcon, TerminalIcon } from './icons.js'
import { call } from './api.js'
import { t } from './i18n.js'

export const GalleryIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('rect', { x: '3', y: '4', width: '14', height: '12', rx: '1.5' }),
  h('path', { d: 'M3 13l3.5-3.5L10 13l2.5-2.5L16 14' }),
  h('circle', { cx: '12.6', cy: '7.6', r: '1.1' }))

const FilmIcon = () => h('svg', { width: 22, height: 22, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('rect', { x: '3', y: '4.5', width: '14', height: '11', rx: '1.5' }), h('path', { d: 'M7 4.5v11M13 4.5v11M3 8h4M3 12h4M13 8h4M13 12h4' }))
const MusicIcon = () => h('svg', { width: 22, height: 22, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M8 15.5V5l7-1.5V14' }), h('circle', { cx: '6.2', cy: '15.5', r: '1.8' }), h('circle', { cx: '13.2', cy: '14', r: '1.8' }))
const DocIcon = () => h('svg', { width: 22, height: 22, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M5 3.5h7l3 3v10H5z' }), h('path', { d: 'M12 3.5v3h3M7.5 10h5M7.5 13h5' }))
const FileIcon = () => h('svg', { width: 22, height: 22, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M5 3.5h6l4 4v9H5z' }), h('path', { d: 'M11 3.5v4h4' }))

export const ASSETS_CSS = `
.bt-as{display:flex;flex-direction:column;gap:12px;padding-bottom:4px}
.bt-as-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-as-chips{display:inline-flex;flex-wrap:wrap;gap:6px}
.bt-as-chips button{height:26px;padding:0 12px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-as-chips button[aria-pressed="true"]{background:var(--bt-ink);color:var(--bt-card)}
.bt-as-search{flex:1;min-width:140px;height:28px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:12.5px;padding:0 10px}
.bt-as-select{height:28px;max-width:200px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:12px;padding:0 6px}
.bt-as-count{color:var(--bt-ink-2);font-size:11.5px;white-space:nowrap}
.bt-as-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px}
.bt-as-card{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:12px;border:.5px solid var(--bt-line-2);background:var(--bt-card);min-width:0}
.bt-as-thumb{position:relative;aspect-ratio:4/3;border-radius:8px;background:var(--bt-hover);display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--bt-ink-2);cursor:pointer;border:0;padding:0;width:100%}
.bt-as-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.bt-as-thumb video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.bt-as-ext{position:absolute;right:5px;bottom:5px;padding:1px 6px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;letter-spacing:.4px;text-transform:uppercase}
.bt-as-name{font-size:12px;line-height:1.3;max-height:2.6em;overflow:hidden;word-break:break-all}
.bt-as-meta{display:flex;align-items:center;gap:6px;color:var(--bt-ink-2);font-size:10.5px}
.bt-as-meta code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}
.bt-as-meta .bt-pj-iconbtn{width:20px;height:20px}
.bt-as-meta .bt-pj-iconbtn svg{width:11px;height:11px}
.bt-as-empty{padding:26px 14px;border:.5px dashed var(--bt-line-2);border-radius:12px;color:var(--bt-ink-2);font-size:12.5px;text-align:center}
.bt-as-viewer{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);padding:28px}
.bt-as-viewer-box{position:relative;max-width:min(920px,92vw);max-height:86vh;display:flex;flex-direction:column;gap:8px}
.bt-as-viewer-box img,.bt-as-viewer-box video{max-width:100%;max-height:76vh;border-radius:12px}
.bt-as-viewer-box audio{width:min(560px,80vw)}
.bt-as-viewer-cap{color:#fff;font-size:12px;text-align:center;word-break:break-all}
.bt-as-viewer-close{position:absolute;top:-14px;right:-14px;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:999px;background:var(--bt-card);color:var(--bt-ink);cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.3)}
.bt-as-note{color:var(--bt-ink-2);font-size:11.5px}
`

const humanSize = size => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB`
  : size >= 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${size} B`
const humanDay = ms => {
  const date = new Date(ms)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return date.toTimeString().slice(0, 5)
  const sameYear = date.getFullYear() === now.getFullYear()
  const day = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return sameYear ? day : `${date.getFullYear()}-${day}`
}

const KIND_TABS = [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio'], ['document', 'Documents'], ['other', 'Other']]

const kindIcon = (kind, ext) => kind === 'video' ? h(FilmIcon) : kind === 'audio' ? h(MusicIcon)
  : kind === 'document' ? h(DocIcon) : kind === 'image' ? h(GalleryIcon) : h(FileIcon)

// A tile: the preview loads when the tile first shows, and only then, so a wall of
// pictures does not fetch its whole wall at once.
const Tile = ({ entry, projectOf, onOpen, copied, onCopy }) => {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)
  const [preview, setPreview] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (node === null || visible) return
    const watch = new IntersectionObserver(entries => {
      if (entries.some(item => item.isIntersecting)) { setVisible(true); watch.disconnect() }
    }, { rootMargin: '240px' })
    watch.observe(node)
    return () => watch.disconnect()
  }, [visible])
  useEffect(() => {
    if (!visible || preview !== null || failed) return
    if (entry.kind !== 'image') return
    let alive = true
    call('asset-read', { path: entry.path }).then(result => { if (alive) setPreview(`data:${result.mime};base64,${result.data}`) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [visible, preview, failed, entry.path, entry.kind])
  const openable = entry.kind === 'video' || entry.kind === 'audio' ? entry.size <= (entry.kind === 'video' ? 32 * 1024 * 1024 : 24 * 1024 * 1024) : entry.kind === 'image'
  return h('div', { className: 'bt-as-card', ref },
    h('button', {
      type: 'button', className: 'bt-as-thumb', title: entry.name,
      onClick: () => { if (openable) onOpen(entry) },
    },
      preview !== null ? h('img', { src: preview, alt: entry.name, loading: 'lazy' })
        : h(kindIcon(entry.kind, entry.ext)),
      h('span', { className: 'bt-as-ext' }, entry.ext.replace('.', '') || entry.kind)),
    h('div', { className: 'bt-as-name' }, entry.name),
    h('div', { className: 'bt-as-meta' },
      h('span', null, humanSize(entry.size)),
      h('span', null, humanDay(entry.mtime)),
      h('span', { className: 'bt-pj-spacer' }),
      projectOf(entry.folder) ? h('span', null, projectOf(entry.folder)) : null,
      h('button', { type: 'button', className: 'bt-pj-iconbtn', title: t('Copy path'), onClick: () => onCopy(entry) }, copied ? '✓' : h(CopyIcon)),
      h('button', { type: 'button', className: 'bt-pj-iconbtn', title: t('Open folder'), onClick: () => void call('asset-reveal', { path: entry.path }).catch(() => {}) }, h(ChevronRightIcon))))
}

export function AssetsPage({ roster, actions, run, Section }) {
  const [data, setData] = useState(null)
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState('all')
  const [viewer, setViewer] = useState(null)
  const [copied, setCopied] = useState(null)
  useEffect(() => { void actions.assets({ limit: 1200 }).then(setData, () => setData({ entries: [], total: 0, roots: [] })) }, [])
  const [projectList, setProjectList] = useState([])
  useEffect(() => { void call('projects').then(view => setProjectList(view?.projects ?? []), () => {}) }, [])
  const shown = useMemo(() => {
    const entries = data?.entries ?? []
    const text = query.trim().toLowerCase()
    const project = projectList.find(item => item.id === projectId)
    return entries.filter(entry => {
      if (kind !== 'all' && entry.kind !== kind) return false
      if (project !== undefined && !entry.path.startsWith(project.folder)) return false
      if (text !== '' && !entry.name.toLowerCase().includes(text)) return false
      return true
    })
  }, [data, kind, query, projectId, projectList])
  const projectOf = useMemo(() => {
    const sorted = [...projectList].sort((a, b) => b.folder.length - a.folder.length)
    return folder => sorted.find(item => folder === item.folder || folder.startsWith(item.folder.endsWith('/') || item.folder.endsWith('\\') ? item.folder : item.folder + '/'))?.name
  }, [projectList])
  const copy = async (entry) => {
    try { await navigator.clipboard.writeText(entry.path); setCopied(entry.path); setTimeout(() => setCopied(current => (current === entry.path ? null : current)), 1200) } catch { /* clipboard may be blocked */ }
  }
  useEffect(() => {
    if (viewer === null) return
    const close = event => { if (event.key === 'Escape') setViewer(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [viewer])
  if (data === null) return null
  const count = data.total ?? 0
  return [
    h('div', { key: 'bar', className: 'bt-as-bar' },
      h('div', { className: 'bt-as-chips' }, KIND_TABS.map(([value, text]) => h('button', {
        key: value, type: 'button', 'aria-pressed': kind === value, onClick: () => setKind(value),
      }, t(text)))),
      projectList.length > 0 ? h('select', { className: 'bt-as-select', value: projectId, 'aria-label': t('All projects'), onChange: event => setProjectId(event.target.value) },
        h('option', { value: 'all' }, t('All projects')),
        projectList.map(project => h('option', { key: project.id, value: project.id }, project.name))) : null,
      h('input', { className: 'bt-as-search', value: query, placeholder: t('Search'), 'aria-label': t('Search'), onChange: event => setQuery(event.target.value) }),
      h('span', { className: 'bt-as-count' }, t('{shown} of {total}', { shown: shown.length, total: count }))),
    h(Section, { key: 'grid', title: t('Assets') },
      shown.length === 0
        ? h('div', { className: 'bt-as-empty' }, t('No assets yet. Files the Bots make in the team workspace and project folders show up here.'))
        : h('div', { className: 'bt-as-grid' }, shown.map(entry => h(Tile, {
          key: entry.path, entry, projectOf, onOpen: entry2 => setViewer(entry2), copied: copied === entry.path, onCopy: entry2 => void copy(entry2),
        })))),
    viewer !== null ? h(AssetViewer, { key: 'viewer', entry: viewer, onClose: () => setViewer(null) }) : null,
  ]
}

const AssetViewer = ({ entry, onClose }) => {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    call('asset-read', { path: entry.path }).then(result => { if (alive) setUrl(`data:${result.mime};base64,${result.data}`) }, failure => { if (alive) setError(failure?.message ?? String(failure)) })
    return () => { alive = false }
  }, [entry.path])
  return h('div', { className: 'bt-as-viewer', onClick: onClose, role: 'dialog', 'aria-label': entry.name },
    h('div', { className: 'bt-as-viewer-box', onClick: event => event.stopPropagation() },
      h('button', { type: 'button', className: 'bt-as-viewer-close', 'aria-label': t('Close'), onClick: onClose }, h(CloseIcon)),
      error !== null ? h('div', { className: 'bt-as-viewer-cap' }, error)
        : url === null ? h('div', { className: 'bt-as-viewer-cap' }, '…')
          : entry.kind === 'video' ? h('video', { src: url, controls: true, autoPlay: true })
            : entry.kind === 'audio' ? h('audio', { src: url, controls: true, autoPlay: true })
              : h('img', { src: url, alt: entry.name }),
      h('div', { className: 'bt-as-viewer-cap' }, entry.name)))
}
