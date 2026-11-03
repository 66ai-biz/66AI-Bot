import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The gallery over the real channel: files in the workspace and project folders are
// listed and classified, previews are served only inside those folders, and anything
// outside them is refused.
function start() {
  const home = mkdtempSync(join(tmpdir(), '66ai-bot-assets-'))
  const workspace = mkdtempSync(join(tmpdir(), '66ai-bot-aw-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async () => ({ agent: { session: { id: 's1' }, followup: () => {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home, workspace })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, home, workspace }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(64, 7)])

test('the gallery lists and classifies files under the team folders', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: 'media' })
    const project = made.value.project
    writeFileSync(join(project.folder, 'cover.png'), PNG)
    writeFileSync(join(project.folder, 'notes.md'), '# hi\n')
    writeFileSync(join(project.folder, 'demo.mp4'), Buffer.alloc(1024, 1))
    mkdirSync(join(app.workspace, 'deep', 'nested'), { recursive: true })
    writeFileSync(join(app.workspace, 'deep', 'nested', 'song.mp3'), Buffer.alloc(512, 2))
    // Junk that must never show up.
    mkdirSync(join(project.folder, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(project.folder, 'node_modules', 'pkg', 'index.js'), 'x')
    writeFileSync(join(project.folder, '.hidden.png'), PNG)

    const view = await app.call('assets', {})
    const names = view.value.entries.map(entry => entry.name)
    assert.ok(names.includes('cover.png'), 'the picture is listed')
    assert.ok(names.includes('notes.md'), 'the document is listed')
    assert.ok(names.includes('demo.mp4'), 'the video is listed')
    assert.ok(names.includes('song.mp3'), 'nested files within the depth limit are listed')
    assert.ok(!names.includes('index.js'), 'node_modules is skipped')
    assert.ok(!names.includes('.hidden.png'), 'dot entries are skipped')
    const byName = name => view.value.entries.find(entry => entry.name === name)
    assert.equal(byName('cover.png').kind, 'image')
    assert.equal(byName('notes.md').kind, 'document')
    assert.equal(byName('demo.mp4').kind, 'video')
    assert.equal(byName('song.mp3').kind, 'audio')
    // Newest first.
    const times = view.value.entries.map(entry => entry.mtime)
    assert.deepEqual([...times].sort((a, b) => b - a), times)
  } finally {
    await app.stop()
  }
})

test('a kind filter keeps only its kind', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: 'mixed' })
    const project = made.value.project
    writeFileSync(join(project.folder, 'a.png'), PNG)
    writeFileSync(join(project.folder, 'b.txt'), 'x')
    const view = await app.call('assets', { kinds: ['image'] })
    assert.deepEqual(view.value.entries.map(entry => entry.name), ['a.png'])
  } finally {
    await app.stop()
  }
})

test('a preview serves bytes inside the team folders and refuses outside ones', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: 'pics' })
    const project = made.value.project
    writeFileSync(join(project.folder, 'cover.png'), PNG)
    const view = await app.call('assets', {})
    const cover = view.value.entries.find(entry => entry.name === 'cover.png')
    const read = await app.call('asset-read', { path: cover.path })
    assert.equal(read.value.mime, 'image/png')
    assert.equal(Buffer.from(read.value.data, 'base64').toString('hex'), PNG.toString('hex'))

    const outside = await app.call('asset-read', { path: join(app.home, 'state.json') })
    assert.ok(outside.error !== undefined || outside.failure !== undefined, 'the team state is not previewable')
    const missing = await app.call('asset-read', { path: join(app.workspace, 'nope.png') })
    assert.ok(missing.error !== undefined || missing.failure !== undefined, 'a missing file is not previewable')
  } finally {
    await app.stop()
  }
})

test('a file too large to preview says so instead of serving bytes', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: 'big' })
    const project = made.value.project
    // 9 MB of picture: over the 8 MB preview cap for images.
    writeFileSync(join(project.folder, 'big.png'), Buffer.alloc(9 * 1024 * 1024, 3))
    const view = await app.call('assets', {})
    const big = view.value.entries.find(entry => entry.name === 'big.png')
    assert.equal(big.size, 9 * 1024 * 1024)
    const read = await app.call('asset-read', { path: big.path })
    assert.ok(read.error !== undefined || read.failure !== undefined, 'an oversized picture is refused with a note')
  } finally {
    await app.stop()
  }
})
