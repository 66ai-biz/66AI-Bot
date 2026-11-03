// Telegram adapter for IM channels: Bot API long polling, so it needs no public
// callback URL — one HTTPS call cycle outbound per poll. api.telegram.org is not
// reachable from every network this App runs on, so an HTTP proxy (CONNECT) is
// supported per channel and falls back to the environment's HTTPS_PROXY.
import { ProxyAgent, fetch as proxiedFetch, WebSocket } from 'undici'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TG_LIMIT = 4096
const POLL_TIMEOUT_S = 25
const RETRY_MS = 5_000

const agentFor = (proxy) => {
  const url = (proxy ?? '').trim() || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  return url.trim() !== '' ? new ProxyAgent(url.trim()) : undefined
}

export const fetchWith = (proxy) => (url, options = {}) => proxiedFetch(url, { ...options, dispatcher: agentFor(proxy) })

// What an undici WebSocket needs to tunnel through an HTTP proxy.
export const wsOptions = (proxy) => {
  const agent = agentFor(proxy)
  return agent === undefined ? {} : { dispatcher: agent }
}

// Long replies ride in one message per chunk; split at the last paragraph or
// newline inside the limit so a chat never receives a broken sentence.
export function chunkText(text, limit) {
  const out = []
  let rest = String(text ?? '').trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.4) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.4) cut = limit
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') out.push(rest)
  return out
}

export const telegram = {
  platform: 'telegram',

  async test(config) {
    const me = await this.who(config)
    return { name: me.username ? `@${me.username}` : me.first_name ?? 'bot' }
  },

  async who(config) {
    const fetcher = fetchWith(config.proxy)
    const response = await fetcher(`https://api.telegram.org/bot${config.token}/getMe`, { signal: AbortSignal.timeout(15_000) })
    const body = await response.json()
    if (!body.ok) throw new Error(body.description ?? 'Telegram refused the token')
    return body.result
  },

  // Returns stop(signal). Reports per-connection trouble through `report`.
  async start(channel, { onInbound, report }) {
    const { token, proxy } = channel.config
    const fetcher = fetchWith(proxy)
    const me = await this.who(channel.config)
    const controller = new AbortController()
    let stopped = false
    let offset = 0

    ;(async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          const response = await fetcher(`https://api.telegram.org/bot${token}/getUpdates`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ timeout: POLL_TIMEOUT_S, offset, allowed_updates: ['message'] }),
            signal: controller.signal,
          })
          const body = await response.json()
          if (!body.ok) throw new Error(body.description ?? 'getUpdates failed')
          report?.(null)
          for (const update of body.result ?? []) {
            offset = update.update_id + 1
            const m = update.message
            if (m === undefined || typeof m.text !== 'string' || m.text.trim() === '') continue
            const group = m.chat?.type !== 'private'
            const mentioned = !group
              || (typeof m.text === 'string' && me.username !== undefined && m.text.includes(`@${me.username}`))
              || m.reply_to_message?.from?.id === me.id
            onInbound({
              chatId: String(m.chat.id),
              chatType: group ? 'group' : 'private',
              userId: String(m.from?.id ?? ''),
              userName: m.from?.first_name ?? m.from?.username ?? '',
              text: me.username !== undefined ? m.text.replaceAll(`@${me.username}`, '').trim() : m.text.trim(),
              mentioned,
            })
          }
        } catch (error) {
          if (stopped || controller.signal.aborted) return
          if (error?.name === 'AbortError') return
          report?.(`Telegram: ${error?.message ?? error}`)
          await new Promise(resolve => setTimeout(resolve, RETRY_MS))
        }
      }
    })().catch(() => {})

    return (signal) => {
      stopped = true
      controller.abort(signal?.reason)
    }
  },

  async send(channel, chatId, text) {
    const fetcher = fetchWith(channel.config.proxy)
    for (const piece of chunkText(text, TG_LIMIT)) {
      const response = await fetcher(`https://api.telegram.org/bot${channel.config.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: piece }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = await response.json().catch(() => ({}))
      if (!body.ok) throw new Error(body.description ?? 'sendMessage failed')
    }
  },
}
