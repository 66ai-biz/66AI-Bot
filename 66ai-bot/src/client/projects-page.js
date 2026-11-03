// The Projects page: a named folder per project under the team workspace. A project
// groups the Bots that work on it and, with the Assets page, everything they make.
import { createElement as h, useEffect, useState } from 'react'
import { ChevronRightIcon, CopyIcon, FolderIcon, PencilIcon, PlusIcon, TrashIcon } from './icons.js'
import { call } from './api.js'
import { t } from './i18n.js'

export const PROJECTS_CSS = `
.bt-pj-list{display:flex;flex-direction:column;gap:10px}
.bt-pj-row{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:12px;border:.5px solid var(--bt-line-2);background:var(--bt-card)}
.bt-pj-head{display:flex;align-items:center;gap:8px;min-width:0}
.bt-pj-head svg{flex:none;width:15px;height:15px;color:var(--bt-ink-2)}
.bt-pj-name{font-weight:600;font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-pj-spacer{flex:1}
.bt-pj-path{display:flex;align-items:center;gap:6px;min-width:0;color:var(--bt-ink-2);font-size:11.5px}
.bt-pj-path code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.bt-pj-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink-2);cursor:pointer;flex:none}
.bt-pj-iconbtn svg{width:13px;height:13px}
.bt-pj-iconbtn:hover{color:var(--bt-ink)}
.bt-pj-bots{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.bt-pj-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 4px 0 9px;border-radius:999px;background:var(--bt-hover);font-size:12px;color:var(--bt-ink)}
.bt-pj-chip button{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border:0;border-radius:999px;background:none;color:var(--bt-ink-2);cursor:pointer;font-size:13px;line-height:1}
.bt-pj-chip button:hover{color:var(--bt-ink)}
.bt-pj-add{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.bt-pj-add select{height:26px;max-width:220px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:12px;padding:0 6px}
.bt-pj-new{display:flex;gap:8px;align-items:center}
.bt-pj-new input{flex:1;height:30px;min-width:120px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;padding:0 10px}
.bt-pj-empty{padding:18px 14px;border:.5px dashed var(--bt-line-2);border-radius:12px;color:var(--bt-ink-2);font-size:12.5px;text-align:center}
`

const ProjectRow = ({ project, roster, actions, run, onRenamed, onDeleted }) => {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(project.name)
  const [confirming, setConfirming] = useState(false)
  const [adding, setAdding] = useState(false)
  const bots = (roster.bots ?? []).filter(bot => bot.projectId === project.id || project.bots.includes(bot.id))
  const candidates = (roster.bots ?? []).filter(bot => !bots.some(kept => kept.id === bot.id))
  const copy = async () => {
    try { await navigator.clipboard.writeText(project.folder) } catch { /* clipboard may be blocked; the path is visible */ }
  }
  const save = async () => {
    const clean = name.trim()
    if (clean === '' || clean === project.name) return setEditing(false)
    if (await run(actions.projectRename(project.id, clean))) { setEditing(false); onRenamed?.() }
  }
  return h('div', { className: 'bt-pj-row' },
    h('div', { className: 'bt-pj-head' },
      h(FolderIcon), editing
        ? h('input', { className: 'bt-input', value: name, autoFocus: true, maxLength: 60, 'aria-label': t('Project name'), onChange: event => setName(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save(); if (event.key === 'Escape') setEditing(false) }, onBlur: () => void save() })
        : h('span', { className: 'bt-pj-name' }, project.name),
      h('span', { className: 'bt-pj-spacer' }),
      h('button', { type: 'button', className: 'bt-pj-iconbtn', title: t('Rename project'), onClick: () => { setName(project.name); setEditing(true) } }, h(PencilIcon)),
      h('button', { type: 'button', className: 'bt-pj-iconbtn', title: t('Open folder'), onClick: () => void actions.projectOpen(project.id).catch(() => {}) }, h(ChevronRightIcon)),
      confirming
        ? h('button', { type: 'button', className: 'bt-pj-iconbtn', title: t('Delete project'), style: { color: 'var(--bt-danger)' }, onClick: () => { setConfirming(false); void run(actions.projectDelete(project.id)).then(ok => { if (ok) onDeleted?.() }) } }, h(TrashIcon))
        : h('button', { type: 'button', className: 'bt-pj-iconbtn', title: t('Delete project'), onClick: () => setConfirming(true) }, h(TrashIcon))),
    h('div', { className: 'bt-pj-path' },
      h('code', null, project.folder),
      h('button', { type: 'button', className: 'bt-pj-iconbtn', title: t('Copy path'), onClick: () => void copy() }, h(CopyIcon))),
    h('div', { className: 'bt-pj-bots' },
      bots.map(bot => h('span', { key: bot.id, className: 'bt-pj-chip' },
        bot.name,
        h('button', { type: 'button', title: t('Remove from project'), onClick: () => void run(actions.updateBot(bot.id, { projectId: null })) }, '×'))),
      adding
        ? h('select', { value: '', 'aria-label': t('Add a Bot to this project'), onChange: event => { const id = event.target.value; setAdding(false); if (id !== '') void run(actions.updateBot(id, { projectId: project.id })) } },
          h('option', { value: '' }, t('Add a Bot to this project')),
          candidates.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))
        : h('button', { type: 'button', className: 'bt-pj-chip', onClick: () => setAdding(true) }, h(PlusIcon), t('Add a Bot'))))
}

export function ProjectsPage({ roster, actions, run, Section }) {
  const [view, setView] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const reload = async () => { try { setView(await actions.projects()) } catch { /* the page stays empty; the host may predate projects */ } }
  useEffect(() => { void reload() }, [])
  const create = async () => {
    const clean = name.trim()
    if (clean === '' || busy) return
    setBusy(true)
    if (await run(actions.projectCreate(clean).then(result => { setName(''); return result }))) await reload()
    setBusy(false)
  }
  if (view === null) return null
  const projects = view.projects ?? []
  return [
    h(Section, { key: 'list', title: t('Projects · {count}', { count: projects.length }) },
      projects.length === 0
        ? h('div', { className: 'bt-pj-empty' }, t('No projects yet. A project is a folder under the team workspace; the Bots in it work there, and their files land in it.'))
        : h('div', { className: 'bt-pj-list' }, projects.map(project => h(ProjectRow, {
          key: project.id, project, roster, actions, run, onRenamed: () => void reload(), onDeleted: () => void reload(),
        })))),
    h('div', { key: 'new', className: 'bt-actions' },
      h('div', { className: 'bt-pj-new' },
        h('input', { value: name, placeholder: t('Project name'), maxLength: 60, 'aria-label': t('Project name'), onChange: event => setName(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void create() } }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || name.trim() === '', onClick: () => void create() }, t('Create project')))),
  ]
}
