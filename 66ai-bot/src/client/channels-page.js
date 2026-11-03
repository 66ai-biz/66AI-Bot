// The Channels page: put each Bot on Telegram, Discord, Feishu or DingTalk. Every
// platform here is an outbound-only long connection, so no public callback URL is
// needed — the App connects out, hears its chat, and answers as the Bot it serves.
import { createElement as h, useEffect, useState } from 'react'
import { ChevronRightIcon, PlusIcon } from './icons.js'
import { call } from './api.js'
import { t } from './i18n.js'
import { Switch } from './bot-settings.js'

export const ChannelIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M3.5 8.5 14 4l-2.2 12-3.4-4.4L3.5 8.5z' }), h('path', { d: 'M8.4 11.6 14 4' }))

export const CHANNELS_CSS = `
.bt-ch{display:flex;flex-direction:column;gap:12px;padding-bottom:4px}
.bt-ch-note{color:var(--bt-ink-2);font-size:11.5px;line-height:1.5}
.bt-ch-row{display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:.5px solid var(--bt-line-weak)}
.bt-ch-row:last-child{border-bottom:0}
.bt-ch-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left}
.bt-ch-dot{width:8px;height:8px;border-radius:999px;background:var(--bt-line-2);flex:none}
.bt-ch-dot[data-on="true"]{background:var(--bt-green)}
.bt-ch-dot[data-on="error"]{background:var(--bt-danger)}
.bt-ch-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ch-stats{color:var(--bt-ink-3);font-size:11px;white-space:nowrap}
.bt-ch-err{color:var(--bt-danger);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ch-form{display:flex;flex-direction:column;gap:12px}
.bt-ch-chips{display:inline-flex;flex-wrap:wrap;gap:6px}
.bt-ch-chips button{height:28px;padding:0 12px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer}
.bt-ch-chips button[aria-pressed="true"]{background:var(--bt-ink);color:var(--bt-card);border-color:var(--bt-ink)}
.bt-ch-input{height:30px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:12.5px;padding:0 10px;width:100%;box-sizing:border-box}
.bt-ch-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-ch-test{color:var(--bt-ink-2);font-size:11.5px}
.bt-ch-test[data-ok="true"]{color:var(--bt-green)}
.bt-ch-test[data-ok="false"]{color:var(--bt-danger)}
`

const humanDay = ms => {
  if (!ms) return ''
  const date = new Date(ms)
  const day = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `${date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}-`}${day} ${date.toTimeString().slice(0, 5)}`
}

// One channel row: the dot says whether it is live (green), failing (red) or
// stopped (grey); the switch is the App's own on/off for the channel.
const Row = ({ channel, platformName, onToggle, onOpen }) => {
  const running = channel.running === true
  const failing = typeof channel.stats?.error === 'string' && channel.stats.error !== ''
  return h('div', { className: 'bt-ch-row' },
    h('button', { type: 'button', className: 'bt-ch-main', onClick: onOpen, title: t('Edit channel') },
      h('span', { className: 'bt-ch-dot', 'data-on': running ? 'true' : failing ? 'error' : 'false' }),
      h('span', { className: 'bt-ch-name' }, channel.name),
      h('span', { className: 'bt-tag' }, platformName),
      channel.botName ? h('span', { className: 'bt-tag' }, channel.botName) : null,
      failing ? h('span', { className: 'bt-ch-err' }, channel.stats.error) : null,
      channel.stats?.received || channel.stats?.sent
        ? h('span', { className: 'bt-ch-stats' }, t('{received} in · {sent} out', { received: channel.stats.received ?? 0, sent: channel.stats.sent ?? 0 }))
        : null,
      h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))),
    h(Switch, { label: t('Enabled'), on: channel.enabled, onChange: on => onToggle(channel, on) }))
}

// The form: platform first (fixed while editing), then the credentials the
// platform needs, then who answers and who may ask.
function ChannelForm({ platform, platformName, channel, fields, hint, roster, onDone, onCancel }) {
  const isEdit = channel !== undefined
  const [name, setName] = useState(channel?.name ?? '')
  const [botId, setBotId] = useState(channel?.botId ?? roster.bots[0]?.id ?? '')
  const [config, setConfig] = useState(() => Object.fromEntries((channel?.config ? Object.entries(channel.config) : []).map(([key, value]) => [key, typeof value === 'string' ? value : ''])))
  const [trigger, setTrigger] = useState(channel?.trigger ?? 'mention')
  const [allowFrom, setAllowFrom] = useState((channel?.allowFrom ?? []).join(', '))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      await call('im-channel-save', {
        ...(isEdit ? { id: channel.id } : {}),
        platform, name, botId, config,
        trigger,
        allowFrom: allowFrom.split(',').map(item => item.trim()).filter(Boolean),
      })
      onDone()
    } finally { setBusy(false) }
  }
  const remove = async () => {
    if (busy || !isEdit) return
    setBusy(true)
    try { await call('im-channel-delete', { id: channel.id }); onDone() } finally { setBusy(false) }
  }
  const test = async () => {
    if (testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await call('im-channel-test', { platform, config })
      setTestResult(result)
    } catch (error) { setTestResult({ ok: false, error: error?.message ?? String(error) }) } finally { setTesting(false) }
  }
  return h('div', { className: 'bt-ch-form' },
    h('div', { className: 'bt-ch-chips' },
      h('button', { type: 'button', 'aria-pressed': true }, platformName)),
    h('label', null, t('Name'),
      h('input', { className: 'bt-ch-input', value: name, maxLength: 60, placeholder: platformName, onChange: event => setName(event.target.value) })),
    h('label', null, t('Bot that answers'),
      h('select', { className: 'bt-ch-input', value: botId, onChange: event => setBotId(event.target.value) },
        roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
    fields.map(field => h('label', { key: field }, t(field === 'proxy' ? 'Proxy (optional)' : field),
      h('input', {
        className: 'bt-ch-input', value: config[field] ?? '',
        placeholder: field === 'proxy' ? t('http://127.0.0.1:7890') : '',
        onChange: event => setConfig(current => ({ ...current, [field]: event.target.value })),
      }))),
    hint ? h('span', { className: 'bt-ch-note' }, hint) : null,
    h('label', null, t('Trigger'),
      h('select', { className: 'bt-ch-input', value: trigger, onChange: event => setTrigger(event.target.value) },
        h('option', { value: 'mention' }, t('When mentioned (groups) or always in private chats')),
        h('option', { value: 'all' }, t('Every message')))),
    h('label', null, t('Allow list (chat or user IDs, comma separated)'),
      h('input', { className: 'bt-ch-input', value: allowFrom, placeholder: t('Empty means everyone'), onChange: event => setAllowFrom(event.target.value) })),
    h('div', { className: 'bt-ch-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: testing, onClick: test }, t('Test connection')),
      testResult !== null ? h('span', { className: 'bt-ch-test', 'data-ok': String(testResult.ok === true) },
        testResult.ok ? t('Connected as {name}', { name: testResult.name ?? '?' }) : testResult.error ?? t('Failed')) : null),
    h('div', { className: 'bt-ch-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: save }, t(isEdit ? 'Save' : 'Add channel')),
      isEdit ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: remove }, t('Delete')) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onCancel }, t('Cancel'))))
}

export function ChannelsPage({ roster, actions, run, Section }) {
  const [view, setView] = useState(null)
  const [editing, setEditing] = useState(null) // { channel } | { platform, platformName }
  const refresh = () => call('im-channels').then(setView, () => setView({ platforms: [], channels: [] }))
  useEffect(() => { void refresh() }, [])
  if (view === null) return null
  const platformName = id => view.platforms.find(item => item.id === id)?.name ?? id
  const toggle = (channel, enabled) => {
    channel.enabled = enabled
    setView({ ...view })
    void run(call('im-channel-toggle', { id: channel.id, enabled }).then(refresh))
  }
  return [
    h('div', { key: 'note', className: 'bt-ch-note' },
      t('Each Bot can sit in Telegram, Discord, Feishu or DingTalk. The App connects out and replies from the Bot you pick — no public address needed. Enterprise WeChat and WeChat Official Accounts need a public callback and come in a later version.')),
    editing !== null ? h(Section, { key: 'form', title: editing.channel ? t('Edit channel') : t('New channel') },
      h(ChannelForm, {
        platform: editing.channel ? editing.channel.platform : editing.platform,
        platformName: editing.channel ? platformName(editing.channel.platform) : editing.platformName,
        channel: editing.channel,
        fields: editing.channel ? editing.channel.fields : (view.platforms.find(item => item.id === editing.platform)?.fields ?? []),
        hint: editing.channel ? editing.channel.hint : (view.platforms.find(item => item.id === editing.platform)?.hint ?? ''),
        roster, onDone: () => { setEditing(null); void refresh() }, onCancel: () => setEditing(null),
      }))
      : h(Section, { key: 'list', title: t('Channels · {count}', { count: view.channels.length }) },
        view.channels.length === 0
          ? h('div', { className: 'bt-ch-note' }, t('No channels yet. Pick a platform below and give a Bot its chat.'))
          : view.channels.map(channel => h(Row, {
            key: channel.id, channel, platformName: platformName(channel.platform),
            onToggle: (item, enabled) => toggle(item, enabled),
            onOpen: () => setEditing({ channel }),
          }))),
    editing === null ? h('div', { key: 'new', className: 'bt-ch-chips' },
      view.platforms.map(platform => h('button', {
        key: platform.id, type: 'button', title: platform.hint,
        onClick: () => setEditing({ platform: platform.id, platformName: platform.name }),
      }, h(PlusIcon), ' ', platform.name))) : null,
  ]
}
