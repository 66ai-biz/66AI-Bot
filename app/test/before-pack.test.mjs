import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Arch } from 'electron-builder'
import { archProblem, beforePack, cleanOldPacks, officeRuntimeRequest } from '../scripts/before-pack.mjs'
import { runtimeTarget } from '../scripts/prepare-runtime.mjs'

test('a build for the architecture of this Node goes on', async () => {
  assert.equal(archProblem({ target: 'arm64', platform: 'darwin', host: 'arm64' }), undefined)
  assert.equal(archProblem({ target: 'x64', platform: 'win32', host: 'x64' }), undefined)
  const asked = []
  const packager = { projectDir: 'app-dir', appInfo: { version: '0.0.0' } }
  await beforePack({ arch: Arch[process.arch], electronPlatformName: process.platform, packager }, async (request) => { asked.push(request) })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].target, runtimeTarget(process.platform, process.arch))
  assert.equal(asked[0].output, join('app-dir', 'build', 'runtime'))
})

test('a build for another architecture stops and says where to build it', async () => {
  assert.equal(archProblem({ target: 'x64', platform: 'darwin', host: 'arm64' }),
    'This Node runs on arm64, so npm installed arm64 native modules, and an x64 app with them would not start. Install the dependencies and build on an Intel Mac, or under Rosetta with an x64 Node.')
  assert.match(archProblem({ target: 'arm64', platform: 'darwin', host: 'x64' }), /build on a Mac with Apple silicon\.$/)
  assert.match(archProblem({ target: 'x64', platform: 'win32', host: 'arm64' }), /build with an x64 Node\.$/)
  assert.match(archProblem({ target: 'universal', platform: 'darwin', host: 'arm64' }), /Build one app per architecture\./)
  const other = process.arch === 'x64' ? 'arm64' : 'x64'
  await assert.rejects(beforePack({ arch: Arch[other], electronPlatformName: process.platform }), new RegExp(`an ${other} app with them would not start`))
})

test('a requested universal build stops before packing either architecture', async () => {
  // electron-builder's MacPackager.doUniversalPack packs x64 then arm64: the hook sees a concrete
  // arch each time, and the universal request only shows in packager.packagerOptions.targets.
  const packager = { packagerOptions: { targets: new Map([[{ nodeName: 'darwin' }, new Map([[Arch.universal, ['dmg']]])]]) } }
  await assert.rejects(beforePack({ arch: Arch.x64, electronPlatformName: 'darwin', packager }), /Build one app per architecture\./)
  await assert.rejects(beforePack({ arch: Arch.arm64, electronPlatformName: 'darwin', packager }), /Build one app per architecture\./)
})

test('electron-builder runs the check before it packs', () => {
  assert.match(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'), /^beforePack: \.\/scripts\/before-pack\.mjs$/m)
})

test('a pack drops old installers but keeps the output it is writing now', async (t) => {
  const appDir = mkdtempSync(join(tmpdir(), 'aibot-packs-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  for (const dir of ['dist-pack11', 'dist-pack12', 'dist-pack19', 'build', 'dist-packy']) {
    mkdirSync(join(appDir, dir))
    writeFileSync(join(appDir, dir, 'marker.txt'), dir)
  }
  const removed = cleanOldPacks(appDir, join(appDir, 'dist-pack19'))
  assert.deepEqual(removed.sort(), ['dist-pack11', 'dist-pack12'])
  const left = (await import('node:fs')).readdirSync(appDir).sort()
  assert.deepEqual(left, ['build', 'dist-pack19', 'dist-packy'])
  assert.equal(cleanOldPacks(appDir, join(appDir, 'win-unpacked')).length, 0)
})

test('the Office payload goes next to the asar for a platform the lock pins', () => {
  const request = officeRuntimeRequest({ arch: Arch.x64, electronPlatformName: 'win32', packager: { projectDir: 'app-dir', appInfo: { version: '9.9.9' } } })
  assert.equal(request.target, 'win-x64')
  assert.equal(request.version, '9.9.9')
  assert.equal(request.output, join('app-dir', 'build', 'runtime'))
  assert.throws(() => officeRuntimeRequest({ arch: Arch.arm64, electronPlatformName: 'win32', packager: { projectDir: 'app-dir' } }), /No Office runtime payload for win32 arm64/)
  assert.match(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'), /from: build\/runtime\/primary-runtime\r?\n\s+to: primary-runtime/u)
})
