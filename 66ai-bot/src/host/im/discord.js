// Discord adapter for IM channels: one gateway WebSocket out (no public webhook),
// replies over the REST API. discord.com needs the same proxy escape hatch as
// Telegram; the gateway tunnel is an HTTP CONNECT through the same ProxyAgent.
import { fetchWith as discordFetch, wsOptions, chunkText } from './telegram.js'

const REST = 'https://discord.com/api/v10'
const LIMIT = 2000
const GUILDS = 1 << 0
const GUILD_MESSAGES = 1 << 9
const MESSAGE_CONTENT = 1 << 15
const INTENTS = GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT

const headers = token => ({ authorization: `Bot ${token}`, 'content-type': 'application/json' })

export const discord = {
  platform: 'discord',

  async test(config) {
    const fetcher = discordFetch(config.proxy)
    const response = await fetcher(`${REST}/users/@me`, { headers: headers(config.token), signal: AbortSignal.timeout(15_000) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.message ?? 'Discord refused the token')
    return { name: body.username ? `@${body.username}` : body.id }
  },

  // One message per chunk, through the REST API.
  async send(channel, chatId, text) {
    const { token } = channel.config
    const fetcher = discordFetch(channel.config.proxy)
    for (const piece of chunkText(text, LIMIT)) {
      const response = await fetcher(`${REST}/channels/${chatId}/messages`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ content: piece }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? 'message send failed')
    }
  },

  // Returns stop(signal). Reconnects from scratch on a closed socket; events
  // during the gap are lost, which a support bot can live with.
  async start(channel, { onInbound, report }) {
    const { token, proxy } = channel.config
    const fetcher = discordFetch(proxy)
    const controller = new AbortController()
    let stopped = false
    let ws = null
    let heartbeat = null
    let seq = null
    let self = null

    const connect = async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          if (self === null) {
            const response = await fetcher(`${REST}/users/@me`, { headers: headers(token), signal: AbortSignal.timeout(15_000) })
            const body = await response.json()
            if (!response.ok) throw new Error(body.message ?? 'Discord refused the token')
            self = body
          }
          await new Promise((resolve, reject) => {
            ws = new WebSocket(`${'wss://gateway.discord.gg'}${'/?v=10&encoding=json'}`, wsOptions(proxy))
            ws.addEventListener('open', () => report?.(null))
            ws.addEventListener('message', event => {
              let payload
              try { payload = JSON.parse(String(event.data)) } catch { return }
              if (payload.s !== null && payload.s !== undefined) seq = payload.s
              if (payload.op === 10) {
                const interval = payload.d?.heartbeat_interval ?? 30_000
                heartbeat ??= setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: seq })) } catch { /* the close handler reconnects */ } }, interval)
                ws.send(JSON.stringify({ op: 2, d: { token, intents: INTENTS, properties: { os: 'windows', browser: '66ai-bot', device: '66ai-bot' } } }))
              } else if (payload.op === 11) {
                // Heartbeat acknowledged.
              } else if (payload.t === 'MESSAGE_CREATE' && payload.d !== undefined) {
                const d = payload.d
                if (d.author?.bot === true) return
                const text = String(d.content ?? '').trim()
                if (text === '') return
                const group = d.guild_id !== undefined
                const mentioned = !group || (Array.isArray(d.mentions) && d.mentions.some(user => user.id === self.id))
                onInbound({
                  chatId: String(d.channel_id),
                  chatType: group ? 'group' : 'private',
                  userId: String(d.author?.id ?? ''),
                  userName: d.member?.nick ?? d.author?.global_name ?? d.author?.username ?? '',
                  text: mentioned ? text.replace(new RegExp(`<@!?${self.id}>`, 'g'), '').trim() : text,
                  mentioned,
                })
              } else if (payload.t === 'RECONNECT') {
                try { ws.close() } catch { /* reconnect below */ }
              }
            })
            ws.addEventListener('close', () => { if (!stopped) reject(new Error('gateway closed')) })
            ws.addEventListener('error', error => reject(error?.message !== undefined ? new Error(String(error.message)) : new Error('gateway error')))
          })
        } catch (error) {
          if (stopped || controller.signal.aborted) return
          report?.(`Discord: ${error?.message ?? error}`)
          clearInterval(heartbeat)
          heartbeat = null
          self = null
          await new Promise(resolve => setTimeout(resolve, 5_000))
        }
      }
    }

    void connect().catch(() => {})

    return (signal) => {
      stopped = true
      controller.abort(signal?.reason)
      clearInterval(heartbeat)
      try { ws?.close() } catch { /* already gone */ }
    }
  },
}

