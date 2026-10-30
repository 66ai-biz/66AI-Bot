import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountBrowserPlugin } from '../../66ai-bot/src/host/browser/mount.js'
import { id, label, systemPrompt, toolDefs } from '../../66ai-bot/src/host/browser/script.js'

export { id, label, systemPrompt, toolDefs }
export const name = '66ai-bot-browser-script'

export function apply(ctx, config = {}) {
  mountBrowserPlugin(ctx, {
    toolDefs,
    defineTool,
    profileRoot: config.profileRoot ?? join(tmpdir(), '66ai-bot-browser-script'),
    headless: config.headless !== false,
    playwrightUrl: config.playwrightUrl,
    async keyOf(exec) {
      return config.botId ?? exec.agent?.session?.header?.id ?? exec.agent?.id ?? 'session'
    },
  })
}
