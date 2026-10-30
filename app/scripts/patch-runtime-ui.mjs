// Patches the shipped DSH client bundles for the 66AI Bot product surface:
// - the Web-mode welcome notice and the DeepSeek official onboarding dialog never inject;
// - the default model catalog presents as GLM 5.3 / GLM 5.3 Pro with the 66AI provider name;
// - the remaining user-facing DeepSeek strings read 66AI;
// - the Web frontend serves the 66AI favicon and a 66AI Bot web-app manifest.
// npm install overwrites node_modules, so this runs again from postinstall (advisory) and
// from beforePack (strict: a package must not ship unpatched).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODELS = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-models', 'lib', 'client.js')
const LLM = join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js')
const WEB_DIST = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
const WEB_ASSETS = join(root, 'assets', 'web')

// A literal patch swaps `from` for `to` exactly once. A line patch rewrites the whole line
// whose start matches `line`, with `to` (without indentation) — the upstream line is long
// and locale paragraphs change, so matching the whole text would be brittle.
const PATCHES = [
  {
    file: MODELS,
    from: 'if (!("dshDesktop" in globalThis)) ctx.slots.inject("settings.onboarding", () => ctx.slots.register({',
    to: 'if (false) ctx.slots.inject("settings.onboarding", () => ctx.slots.register({',
    why: 'the Web-mode welcome notice never injects',
  },
  {
    file: MODELS,
    from: 'ctx.slots.inject("settings.onboarding", () => ctx.slots.register({\n\t\t\t\tname: "settings.onboarding",\n\t\t\t\tid: "deepseek-official",',
    to: 'if (false) ctx.slots.inject("settings.onboarding", () => ctx.slots.register({\n\t\t\t\tname: "settings.onboarding",\n\t\t\t\tid: "deepseek-official",',
    why: 'the DeepSeek official onboarding dialog never injects',
  },
  {
    file: MODELS,
    line: 'welcomeBody: "DeepSeek Harness 0.2',
    to: 'welcomeBody: "66AI Bot brings a team of cooperating Bots: create your own Bots, group them, and let them work on tasks together.",',
    why: 'the English welcome copy reads 66AI Bot',
  },
  {
    file: MODELS,
    line: 'welcomeBody: "DeepSeek Harness 目前的',
    to: 'welcomeBody: "66AI Bot 为你带来多 Bot 协作的智能团队：创建专属 Bot、组建群聊、协同完成任务。",',
    why: 'the Chinese welcome copy reads 66AI Bot',
  },
  {
    file: MODELS,
    from: 'deepSeekAccount: "DeepSeek Account",',
    to: 'deepSeekAccount: "66AI Account",',
    why: 'the English account label reads 66AI',
  },
  {
    file: MODELS,
    from: 'deepSeekAccount: "DeepSeek 账号",',
    to: 'deepSeekAccount: "66AI 账号",',
    why: 'the Chinese account label reads 66AI',
  },
  {
    file: MODELS,
    from: 'onboardingDescription: "Configure the official DeepSeek provider to start building.",',
    to: 'onboardingDescription: "Configure the GLM model engine to start building.",',
    why: 'the English onboarding copy reads GLM',
  },
  {
    file: MODELS,
    from: 'onboardingDescription: "配置 DeepSeek 官方模型，即可开始使用。",',
    to: 'onboardingDescription: "配置 GLM 模型引擎，即可开始使用。",',
    why: 'the Chinese onboarding copy reads GLM',
  },
  {
    file: LLM,
    from: 'name: "DeepSeek-V4.1-Flash",',
    to: 'name: "GLM 5.3",',
    why: 'the default flash model presents as GLM 5.3',
  },
  {
    file: LLM,
    from: 'name: "DeepSeek-V4-Pro",',
    to: 'name: "GLM 5.3 Pro",',
    why: 'the default pro model presents as GLM 5.3 Pro',
  },
  {
    file: LLM,
    from: 'name: this.dependencies.providerName ?? "DeepSeek"',
    to: 'name: this.dependencies.providerName ?? "66AI"',
    why: 'the provider display name falls back to 66AI',
  },
]

/** Apply one patch to one file's text; returns { text, applied } or { problem }. */
function applyPatch(text, patch, cache) {
  const content = cache.get(patch.file)
  if (patch.line !== undefined) {
    if (content.includes(`\t${patch.to}`) || content.includes(` ${patch.to}`)) return { text, applied: false }
    const lines = text.split('\n')
    const at = lines.findIndex(line => line.includes(patch.line))
    if (at === -1) return { problem: `no line starting with ${JSON.stringify(patch.line)}` }
    const indent = /^[\t ]*/u.exec(lines[at])[0]
    lines[at] = `${indent}${patch.to}`
    return { text: lines.join('\n'), applied: true }
  }
  if (content.includes(patch.to)) return { text, applied: false }
  const at = text.indexOf(patch.from)
  if (at === -1) return { problem: 'the anchor text is missing' }
  if (text.indexOf(patch.from, at + 1) !== -1) return { problem: 'the anchor text is not unique' }
  return { text: `${text.slice(0, at)}${patch.to}${text.slice(at + patch.from.length)}`, applied: true }
}

/**
 * Patch every bundle; each file is read once, patched, and written back only when changed.
 * The Web frontend's favicon and manifest are copied/rewritten rather than swapped in place.
 * @param {{ warn?: boolean }} options - warn: report failures without failing the process
 *   (postinstall); the default is strict (beforePack).
 * @returns {Promise<{ applied: number, problems: string[] }>}
 */
export async function patchRuntimeUi({ warn = false } = {}) {
  const files = [...new Set(PATCHES.map(patch => patch.file))]
  const originals = new Map(files.map(file => [file, readFileSync(file, 'utf8')]))
  const texts = new Map(originals)
  const problems = []
  let applied = 0
  for (const patch of PATCHES) {
    const outcome = applyPatch(texts.get(patch.file), patch, originals)
    if (outcome.problem !== undefined) {
      problems.push(`${patch.why}: ${outcome.problem}`)
      continue
    }
    if (outcome.applied) applied += 1
    texts.set(patch.file, outcome.text)
  }
  for (const file of files) {
    if (texts.get(file) !== originals.get(file)) writeFileSync(file, texts.get(file))
  }
  // The favicon ships as a built asset; the manifest only renames two fields.
  try {
    for (const name of ['favicon.svg', 'favicon-dark.svg']) {
      copyFileSync(join(WEB_ASSETS, name), join(WEB_DIST, name))
    }
    const manifest = join(WEB_DIST, 'manifest.webmanifest')
    const text = readFileSync(manifest, 'utf8')
    const renamed = text.replaceAll('"name": "DeepSeek Harness"', '"name": "66AI Bot"').replaceAll('"short_name": "DSH"', '"short_name": "66AI Bot"')
    if (renamed !== text) {
      writeFileSync(manifest, renamed)
      applied += 1
    }
  } catch (error) {
    problems.push(`the Web frontend favicon and manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const problem of problems) {
    if (warn) console.warn(`66AI Bot: the UI patch could not apply (${problem})`)
    else console.error(`66AI Bot: the UI patch failed: ${problem}`)
  }
  if (problems.length > 0 && !warn) process.exitCode = 1
  return { applied, problems }
}

/* c8 ignore next -- the CLI entry */
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  const result = await patchRuntimeUi({ warn: process.argv.includes('--warn') })
  console.log(`66AI Bot: ${String(result.applied)} UI patches applied${result.problems.length > 0 ? `, ${String(result.problems.length)} problem(s)` : ''}.`)
}
