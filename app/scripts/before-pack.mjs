// electron-builder's beforePack hook. The native modules go into the package as npm installed them
// (npmRebuild: false), so they fit only the architecture of the Node that ran npm. An app built for
// another architecture would carry them and not start, so such a build stops here.
import { Arch } from 'electron-builder'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { patchRuntimeUi } from './patch-runtime-ui.mjs'
import { preparePrimaryRuntime, runtimeTarget } from './prepare-runtime.mjs'

// Every release used a fresh `-c.directories.output=dist-packN` (SAFE_DELETE blocks
// removing the previous one by hand), so the app dir collected a pile of old installers.
// A build now drops its predecessors as it starts, keeping only the directory it writes.
const PACK_DIR = /^dist-pack\d*$/

/**
 * Remove stale `dist-pack*` output siblings of the directory this build writes into.
 * A build with no such outDir (a test mock, a CI mac build using another layout) is a no-op.
 * @returns {string[]} the names that were removed
 */
export function cleanOldPacks(appDir, outDir) {
  const current = outDir === undefined || outDir === null ? '' : basename(resolve(outDir))
  if (!PACK_DIR.test(current)) return []
  const removed = []
  for (const entry of readdirSync(appDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PACK_DIR.test(entry.name) || entry.name === current) continue
    try {
      rmSync(join(appDir, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    } catch { /* a locked old dir (a running app) must never stop this build */ }
  }
  return removed
}

const WHERE = {
  darwin: { x64: 'on an Intel Mac, or under Rosetta with an x64 Node', arm64: 'on a Mac with Apple silicon' },
}

/** @returns {string | undefined} why this Node cannot build an app for `target` */
export function archProblem({ target, platform, host = process.arch, targets = [] }) {
  // electron-builder packs a universal app one architecture at a time: the hook only sees the
  // inner x64/arm64 builds, so a universal request is known from the requested targets.
  if (target === 'universal' || targets.includes('universal')) return 'A universal app would need the native modules of both architectures. Build one app per architecture.'
  if (target === host) return undefined
  const where = WHERE[platform]?.[target] ?? `with an ${target} Node`
  return `This Node runs on ${host}, so npm installed ${host} native modules, and an ${target} app with them would not start. Install the dependencies and build ${where}.`
}

/**
 * The Office payload the package ships next to the asar through extraResources; it must
 * match the package's own platform and architecture, which the arch check guarantees.
 * @param {*} context - electron-builder's beforePack context.
 * @returns {{ target: string, output: string, cache: string, version: string }}
 */
export function officeRuntimeRequest(context) {
  const target = runtimeTarget(context.electronPlatformName, Arch[context.arch])
  if (target === undefined) throw new Error(`No Office runtime payload for ${context.electronPlatformName} ${Arch[context.arch]}.`)
  // The context's packager is the PlatformPackager; the app directory lives on its Packager
  // (.info), exposed directly as projectDir. For this one-package app they are the same.
  const appDir = context.packager.appDir ?? context.packager.projectDir
  return {
    target,
    output: join(appDir, 'build', 'runtime'),
    cache: process.env.AIBOT_RUNTIME_CACHE ?? join(appDir, 'build', 'runtime-cache'),
    version: context.packager?.appInfo?.version
      ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  }
}

export async function beforePack(context, prepare = preparePrimaryRuntime) {
  // Drop earlier releases' output before this one is staged; keep only context.outDir.
  if (context.outDir) {
    const removed = cleanOldPacks(dirname(resolve(context.outDir)), context.outDir)
    if (removed.length) console.log(`[before-pack] removed old installers: ${removed.join(', ')}`)
  }
  const targets = []
  for (const archToNames of context.packager?.packagerOptions?.targets?.values() ?? [])
    for (const arch of archToNames.keys()) targets.push(Arch[arch])
  const problem = archProblem({ target: Arch[context.arch], platform: context.electronPlatformName, targets })
  if (problem !== undefined) throw new Error(problem)
  // npm install may have restored the upstream bundles; the package ships the patched ones.
  await patchRuntimeUi()
  await prepare(officeRuntimeRequest(context))
}
