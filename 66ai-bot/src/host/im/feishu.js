// Feishu adapter for IM channels: the official SDK's WebSocket long connection,
// so it needs no public callback URL and no proxy — open.feishu.cn is reachable
// from the networks this App runs in. Group chats answer @mentions by default.
import * as lark from '@larksuiteoapi/node-sdk'

const limit = 150 // feishu text messages cap well below the others' limits

export const feishu = {
  platform: 'feishu',

  async test(config) {
    const client = new lark.Client({ appId: config.appId, appSecret: config.appSecret })
    const response = await client.bot.botInfo.get()
    if (response.code !== 0) throw new Error(response.msg ?? 'Feishu refused the credentials')
    return { name: response.data?.bot?.app_name ?? response.data?.bot?.app_id ?? 'bot' }
  },

  // Returns stop(signal).
  async start(channel, { onInbound, report }) {
    const { appId, appSecret } = channel.config
    const client = new lark.Client({ appId, appSecret })
    let stopped = false
    let ws = null
    const self = { openId: null }

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        if (stopped) return
        try {
          if (self.openId === null) {
            const info = await client.bot.botInfo.get()
            self.openId = info.data?.bot?.open_id ?? null
          }
          const message = data.message ?? {}
          let text = ''
          try {
            const parsed = JSON.parse(message.content ?? '{}')
            text = String(parsed.text ?? '').trim()
          } catch { text = '' }
          if (text === '') return
          const group = message.chat_type !== 'p2p'
          const mentions = message.mentions ?? []
          const mentioned = !group || mentions.some(m => m.id?.open_id === self.openId)
          for (const m of mentions) text = text.replaceAll(m.key ?? '', '').trim()
          if (text === '') return
          onInbound({
            chatId: String(message.chat_id ?? ''),
            chatType: group ? 'group' : 'private',
            userId: String(data.sender?.sender_id?.open_id ?? ''),
            userName: data.sender?.sender_id?.open_id ?? '',
            text,
            mentioned,
          })
        } catch (error) {
          report?.(`Feishu: ${error?.message ?? error}`)
        }
      },
    })

    report?.(null)
    ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.error })
    const started = ws.start({ eventDispatcher: dispatcher }).catch(error => { if (!stopped) report?.(`Feishu: ${error?.message ?? error}`) })

    return (signal) => {
      stopped = true
      try { ws.close?.() } catch { /* SDK cleans up */ }
      void started
      void signal
    }
  },

  async send(channel, chatId, text) {
    const client = new lark.Client({ appId: channel.config.appId, appSecret: channel.config.appSecret })
    for (const piece of chunkFeishu(text, limit)) {
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ text: piece }), msg_type: 'text' },
      })
      if (response.code !== 0) throw new Error(response.msg ?? 'send failed')
    }
  },
}

export function chunkFeishu(text, limit) {
  const out = []
  let rest = String(text ?? '').trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.4) cut = limit
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') out.push(rest)
  return out
}
