// DingTalk adapter for IM channels: the official stream-mode SDK holds one
// outbound WebSocket to DingTalk, so it needs no public callback URL. A robot
// only receives group messages it was @mentioned in, and replies ride the
// sessionWebhook that came with the inbound message.
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'

const limit = 2000

export const dingtalk = {
  platform: 'dingtalk',
  // chatId -> { url, expiresAt }, refreshed on every inbound message.
  webhooks: new Map(),

  async test(config) {
    const client = new DWClient({ clientId: config.clientId, clientSecret: config.clientSecret })
    const response = await client.getAccessToken()
    const token = response?.accessToken ?? response?.access_token
    if (typeof token !== 'string' || token === '') throw new Error(response?.errmsg ?? 'DingTalk refused the credentials')
    return { name: 'dingtalk app' }
  },

  // Returns stop(signal).
  async start(channel, { onInbound, report }) {
    const { clientId, clientSecret } = channel.config
    let stopped = false

    const client = new DWClient({ clientId, clientSecret })
    client.registerCallbackListener(TOPIC_ROBOT, async (down) => {
      if (stopped) return { code: 200, message: 'OK' }
      try {
        report?.(null)
        const data = JSON.parse(down.data ?? '{}')
        const text = String(data?.text?.content ?? '').trim().replace(/^@\S+\s*/, '')
        if (text === '') return { code: 200, headers: { contentType: 'application/json' }, message: 'OK' }
        const chatId = String(data.conversationId ?? '')
        const webhook = String(data.sessionWebhook ?? '')
        if (webhook !== '') dingtalk.webhooks.set(chatId, { url: webhook, expiresAt: Number(data.sessionWebhookExpiredTime ?? 0) })
        onInbound({
          chatId,
          chatType: data.conversationType === '1' ? 'private' : 'group',
          userId: String(data.senderStaffId ?? data.senderId ?? ''),
          userName: String(data.senderNick ?? ''),
          text,
          // The stream only pushes group messages the robot was @mentioned in.
          mentioned: true,
        })
        return { code: 200, headers: { contentType: 'application/json' }, message: 'OK' }
      } catch (error) {
        report?.(`DingTalk: ${error?.message ?? error}`)
        return { code: 200, message: 'OK' }
      }
    })

    report?.(null)
    void client.connect().catch(error => { if (!stopped) report?.(`DingTalk: ${error?.message ?? error}`) })

    return (signal) => {
      stopped = true
      try { client.disconnect?.() } catch { /* SDK cleans up */ }
      void signal
    }
  },

  async send(channel, chatId, text) {
    const entry = this.webhooks.get(chatId)
    if (entry === undefined || (entry.expiresAt > 0 && entry.expiresAt <= Date.now())) {
      throw new Error('No session webhook for this chat yet — message the bot first')
    }
    const response = await fetch(entry.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, limit) } }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`sessionWebhook ${response.status}`)
  },
}
