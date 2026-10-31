import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { corruptStamp, patchFilesIn, quarantineBrokenPatches } from '../src/patch-guard.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// A home with the team profile, a first-run-check profile and the app's own overlays.
function setup(t) {
  const home = mkdtempSync(join(tmpdir(), '66ai-bot-patch-guard-'))
  t.after(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  write(join(home, 'profiles', '66ai-bot', 'cordis.patch.yml'), '- id: llm-deepseek\n  apiKeyEnv: AIBOT_KEY\n')
  write(join(home, 'profiles', 'import-check', 'cordis.patch.yml'), '[]\n')
  write(join(home, 'profiles', 'office.patch.yml'), '- id: office\n')
  write(join(home, 'profiles', 'search-selector.patch.yml'), '- id: search\n')
  return home
}

test('patch files DSH parses are enumerated for the home', (t) => {
  const home = setup(t)
  const files = patchFilesIn(home)
  assert.equal(files.length, 4)
  assert.ok(files.includes(join(home, 'cordis.patch.yml')) === false, 'the home-level layer is optional and absent here')
  assert.ok(files.some(file => file.endsWith(join('profiles', '66ai-bot', 'cordis.patch.yml'))))
  assert.ok(files.some(file => file.endsWith(join('profiles', 'import-check', 'cordis.patch.yml'))))
  assert.ok(files.some(file => file.endsWith(join('profiles', 'office.patch.yml'))))
  assert.ok(files.some(file => file.endsWith(join('profiles', 'search-selector.patch.yml'))))
})

test('a zero-filled patch is quarantined beside itself and the boot can start clean', (t) => {
  const home = setup(t)
  const zeroed = join(home, 'profiles', '66ai-bot', 'cordis.patch.yml')
  writeFileSync(zeroed, Buffer.alloc(1246))
  const moved = quarantineBrokenPatches(home, { now: new Date(2026, 9, 31, 15, 48, 12) })
  assert.equal(moved.length, 1)
  assert.equal(moved[0].file, zeroed)
  assert.ok(moved[0].archive.endsWith('cordis.patch.yml.corrupt-20261031-154812'))
  assert.ok(!existsSync(zeroed), 'the broken file no longer sits where DSH parses it')
  assert.equal(readFileSync(moved[0].archive).length, 1246, 'the bytes stay for inspection')
})

test('a patch with a raw NUL byte is quarantined even when a parser might accept it', (t) => {
  const home = setup(t)
  const file = join(home, 'profiles', 'search-selector.patch.yml')
  writeFileSync(file, Buffer.from('- id: search\n- id: bad\u0000row\n', 'utf8'))
  const moved = quarantineBrokenPatches(home)
  assert.deepEqual(moved.map(row => row.file), [file])
  assert.match(moved[0].reason, /NUL byte/)
})

test('valid and empty patch files stay where they are', (t) => {
  const home = setup(t)
  write(join(home, 'profiles', '66ai-bot', 'cordis.patch.yml'), '') // an empty layer is valid
  write(join(home, 'profiles', 'office.patch.yml'), '- id: office\n  config:\n    enabled: true\n')
  assert.equal(quarantineBrokenPatches(home).length, 0)
  const entries = readdirSync(join(home, 'profiles'))
  assert.ok(!entries.some(name => name.includes('.corrupt-')))
})

test('a missing home and absent files are a quiet no-op', (t) => {
  const home = mkdtempSync(join(tmpdir(), '66ai-bot-patch-guard-'))
  t.after(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual(quarantineBrokenPatches(home), [])
  assert.deepEqual(patchFilesIn(join(home, 'not-there')), [])
})

test('the stamp is zero-padded local time', () => {
  assert.equal(corruptStamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405')
})
