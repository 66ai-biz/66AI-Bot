// Projects: a named folder that groups Bots, their chats and the files they make.
// A project's folder is made under the team workspace, so everything a project's Bots
// write lands in one folder a user can find in their file manager. The record only
// names the folder; deleting a project never deletes the folder or its files.
import { mkdir, realpath, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

const MAX_NAME = 60

// A project name becomes a folder name, so it cannot hold path separators or the
// characters Windows forbids. Length is capped so deep nesting stays manageable.
export const nameProblem = (name) => {
  const text = String(name ?? '').trim()
  if (text === '') return 'Give the project a name'
  if (text.length > MAX_NAME) return `A project name is at most ${MAX_NAME} characters`
  if (/[\\/:*?"<>|\x00-\x1f]/.test(text)) return 'A project name cannot contain \\ / : * ? " < > |'
  if (text === '.' || text === '..') return 'That name cannot be a folder'
  return undefined
}

export function install(rt) {
  const { ctx, state } = rt
  state.projects = state.projects ?? {}

  // Same view of the team workspace folders.js keeps: the DSH workspace the desktop
  // app named, else the workspace default. Projects live inside it.
  const teamFolder = () => ctx.workspaceRegistry.get?.(state.workspaceId)?.path
    ?? rt.config.workspace
    ?? (process.env.AIBOT_WORKSPACE?.trim() || undefined)

  const table = () => (state.projects = state.projects ?? {})
  const projectOf = id => (id === null || id === undefined ? undefined : table()[id])

  const botIdsOf = projectId => Object.values(state.bots)
    .filter(bot => bot.projectId === projectId).map(bot => bot.id)

  const viewOf = ({ withCounts } = {}) => {
    const entries = Object.values(table()).map(project => ({
      id: project.id,
      name: project.name,
      folder: project.folder,
      createdAt: project.createdAt,
      bots: botIdsOf(project.id),
    }))
    entries.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    return { teamFolder: teamFolder() ?? null, projects: entries }
  }

  async function projectCreate({ name } = {}) {
    const problem = nameProblem(name)
    if (problem !== undefined) throw new Error(problem)
    const clean = String(name).trim()
    const clash = Object.values(table()).find(project => project.name.toLowerCase() === clean.toLowerCase())
    if (clash !== undefined) throw new Error(`A project named ${clean} already exists`)
    const base = teamFolder()
    if (base === undefined) throw new Error('No team workspace is set, so a project folder cannot be made')
    const folder = join(resolve(base), clean)
    await mkdir(folder, { recursive: true })
    const real = await realpath(folder)
    const found = await stat(real).then(info => info.isDirectory(), () => false)
    if (!found) throw new Error(`${clean} could not be made as a folder`)
    const project = { id: randomUUID(), name: clean, folder: real, createdAt: Date.now() }
    table()[project.id] = project
    await rt.save()
    return { project: { ...project, bots: [] } }
  }

  // Only the display name changes; the folder keeps its place, so no Session has to move.
  async function projectRename({ id, name } = {}) {
    const project = projectOf(id)
    if (project === undefined) throw new Error('Unknown project')
    const problem = nameProblem(name)
    if (problem !== undefined) throw new Error(problem)
    const clean = String(name).trim()
    const clash = Object.values(table()).find(entry => entry.id !== id && entry.name.toLowerCase() === clean.toLowerCase())
    if (clash !== undefined) throw new Error(`A project named ${clean} already exists`)
    project.name = clean
    await rt.save()
    return { project: { ...project, bots: botIdsOf(id) } }
  }

  // The record goes; the folder and every file in it stay as they are. Bots keep their
  // folder (their workDir), they only leave the project.
  async function projectDelete({ id } = {}) {
    const project = projectOf(id)
    if (project === undefined) throw new Error('Unknown project')
    delete table()[id]
    for (const bot of Object.values(state.bots)) {
      if (bot.projectId === id) delete bot.projectId
    }
    await rt.save()
    return { ok: true }
  }

  // A Bot joins a project: from now on the gallery groups its files under it. A Bot
  // with no folder of its own starts working in the project's folder; the caller runs
  // that through update-bot's folder change, so Sessions move the usual way.
  async function projectSetBot({ botId, projectId } = {}) {
    const bot = rt.botOf?.(botId)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (projectId === null || projectId === undefined || projectId === '') {
      delete bot.projectId
      await rt.save()
      return { ok: true }
    }
    const project = projectOf(projectId)
    if (project === undefined) throw new Error('Unknown project')
    bot.projectId = project.id
    await rt.save()
    return { ok: true }
  }

  // Show the project's folder in the file manager. The host process is the app's own,
  // so this only ever opens a folder the app itself made.
  async function projectOpen({ id } = {}) {
    const project = projectOf(id)
    if (project === undefined) throw new Error('Unknown project')
    reveal(project.folder)
    return { ok: true }
  }

  const reveal = (path) => {
    try {
      if (process.platform === 'win32') spawn('explorer.exe', [`/select,${path}`], { detached: true, stdio: 'ignore' }).unref()
      else if (process.platform === 'darwin') spawn('open', ['-R', path], { detached: true, stdio: 'ignore' }).unref()
      else spawn('xdg-open', [path], { detached: true, stdio: 'ignore' }).unref()
    } catch {
      // Opening the file manager is best effort; the path is on the page to copy.
    }
  }

  rt.projectsView = async (options = {}) => viewOf(options)
  rt.projectOf = projectOf
  rt.projectCreate = projectCreate
  rt.projectRename = projectRename
  rt.projectDelete = projectDelete
  rt.projectSetBot = projectSetBot
  rt.projectOpen = projectOpen
  rt.revealPath = reveal
  rt.projectBotIds = botIdsOf
}
