import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountBrowserPlugin } from '../../66ai-bot/src/host/browser/mount.js'
import { sessionComplete } from '../../66ai-bot/src/host/browser/session-model.js'
import { id, label, systemPrompt, toolDefs } from '../../66ai-bot/src/host/browser/task.js'

export { id, label, systemPrompt, toolDefs }
export const name = '66ai-bot-browser-task'

export function apply(ctx, config = {}) {
  mountBrowserPlugin(ctx, {
    toolDefs,
    defineTool,
    profileRoot: config.profileRoot ?? join(tmpdir(), '66ai-bot-browser-task'),
    headless: config.headless !== false,
    playwrightUrl: config.playwrightUrl,
    completeFor: exec => sessionComplete(ctx, exec),
    async keyOf(exec) {
      return config.botId ?? exec.agent?.session?.header?.id ?? exec.agent?.id ?? 'session'
    },
  })
}
