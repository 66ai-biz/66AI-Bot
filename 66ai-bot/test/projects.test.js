import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The team and its projects over the real channel: projects are folders under the
// workspace, Bots can be born into them, and deleting a project keeps its files.
function start() {
  const home = mkdtempSync(join(tmpdir(), '66ai-bot-projects-'))
  // realpath: mkdtemp may hand back an 8.3 short path, while folders compare real paths.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), '66ai-bot-ws-')))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek/deepseek-chat' }],
      resolveModelInfo: async () => ({}),
    },
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
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
    },
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
  return { call, stop, home, workspace, sent }
}

test('a project makes its folder under the team workspace, and the view lists it', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: '新品发布' })
    const project = made.value.project
    assert.equal(made.value.project.name, '新品发布')
    // The host stores the folder as an fs.realpath; on this machine the sync realpath
    // keeps an 8.3 short path, so expand the workspace the same way before comparing.
    assert.ok(made.value.project.folder.startsWith(await realpath(app.workspace)), 'folder sits in the workspace')
    assert.ok(existsSync(made.value.project.folder), 'the folder exists on disk')
    const view = await app.call('projects', {})
    assert.equal(view.value.projects.length, 1)
    assert.equal(view.value.projects[0].folder, made.value.project.folder)
    assert.deepEqual(view.value.projects[0].bots, [])
  } finally {
    await app.stop()
  }
})

test('a project name cannot be a path and cannot repeat', async () => {
  const app = start()
  try {
    await app.call('project-create', { name: 'alpha' })
    const again = await app.call('project-create', { name: 'alpha' })
    assert.ok(again.error !== undefined || again.failure !== undefined, 'a repeat name is refused')
    const sneaky = await app.call('project-create', { name: '../escape' })
    assert.ok(sneaky.error !== undefined || sneaky.failure !== undefined, 'a name with a path escapes nothing')
    const view = await app.call('projects', {})
    assert.equal(view.value.projects.length, 1)
  } finally {
    await app.stop()
  }
})

test('rename changes the display name and keeps the folder', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: 'draft' })
    const project = made.value.project
    const renamed = await app.call('project-rename', { id: project.id, name: '发布' })
    assert.equal(renamed.value.project.name, '发布')
    assert.equal(renamed.value.project.folder, project.folder)
    assert.ok(existsSync(project.folder))
  } finally {
    await app.stop()
  }
})

test('a Bot born into a project works in the project folder', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: 'research' })
    const project = made.value.project
    const born = await app.call('create-bot', { name: ' scout ', projectId: project.id })
    assert.equal(born.value.projectId, project.id)
    assert.equal(born.value.workDir, project.folder)
  } finally {
    await app.stop()
  }
})

test('joining a project later moves a folder-less Bot into it; leaving only clears the mark', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: 'site' })
    const project = made.value.project
    const madeBot = await app.call('create-bot', { name: 'writer' })
    const bot = madeBot.value
    assert.equal(bot.workDir, undefined)
    const joined = await app.call('update-bot', { id: bot.id, projectId: project.id })
    assert.equal(joined.value.projectId, project.id)
    assert.equal(joined.value.workDir, project.folder)
    const left = await app.call('update-bot', { id: bot.id, projectId: null })
    assert.equal(left.value.projectId, undefined)
    assert.equal(left.value.workDir, project.folder, 'the folder stays until the user changes it')
  } finally {
    await app.stop()
  }
})

test('deleting a project keeps its folder and clears membership', async () => {
  const app = start()
  try {
    const made = await app.call('project-create', { name: 'temp' })
    const project = made.value.project
    const madeBot = await app.call('create-bot', { name: 'helper', projectId: project.id })
    const bot = madeBot.value
    await app.call('project-delete', { id: project.id })
    const view = await app.call('projects', {})
    assert.equal(view.value.projects.length, 0)
    assert.ok(existsSync(project.folder), 'the folder and its files stay')
    const state = await app.call('state', {})
    const kept = state.value.bots.find(entry => entry.id === bot.id)
    assert.equal(kept?.projectId, undefined)
  } finally {
    await app.stop()
  }
})

test('a project can live in a custom folder on another drive path', async () => {
  const app = start()
  // A second tree outside the team workspace stands in for "another drive".
  const custom = realpathSync(mkdtempSync(join(tmpdir(), '66ai-bot-custom-')))
  try {
    const made = await app.call('project-create', { name: '大项目', folder: custom })
    const project = made.value.project
    // The host stores the folder as an fs.realpath; expand the custom parent the same way.
    assert.ok(project.folder.startsWith(await realpath(custom)), 'the project folder sits in the custom parent')
    assert.ok(!project.folder.startsWith(app.workspace), 'it is not inside the team workspace')
    assert.ok(existsSync(project.folder), 'the folder exists on disk')
    // A Bot born into it works in the custom folder too.
    const born = await app.call('create-bot', { name: 'mover', projectId: project.id })
    assert.equal(born.value.workDir, project.folder)
    const view = await app.call('projects', {})
    assert.equal(view.value.projects[0].folder, project.folder)
  } finally {
    rmSync(custom, { recursive: true, force: true, maxRetries: 5 })
    await app.stop()
  }
})

test('a custom folder must be absolute and sane', async () => {
  const app = start()
  try {
    const relative = await app.call('project-create', { name: 'bad1', folder: 'relative/path' })
    assert.ok(relative.error !== undefined || relative.failure !== undefined, 'a relative folder is refused')
    const sneaky = await app.call('project-create', { name: 'bad2', folder: 'E:\\x<bad>' })
    assert.ok(sneaky.error !== undefined || sneaky.failure !== undefined, 'forbidden characters are refused')
    const view = await app.call('projects', {})
    assert.equal(view.value.projects.length, 0, 'nothing was created')
    // An empty string falls back to the team workspace default.
    const made = await app.call('project-create', { name: 'default-place', folder: '   ' })
    assert.ok(made.value.project.folder.startsWith(await realpath(app.workspace)), 'empty folder falls back to the workspace')
  } finally {
    await app.stop()
  }
})
