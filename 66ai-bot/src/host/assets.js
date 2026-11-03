// Assets: the files a team makes — pictures, videos, audio, documents and the rest —
// listed for the gallery page, and served back for previews under a guard. Only the
// team workspace, the project folders and the folders Bots work in are scanned or read;
// the app's own data (DSH home, the team state) never is.
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { within } from './folders.js'

const MAX_DEPTH = 4
const MAX_FILES = 3000
// A preview travels as base64 through the api, so big media stays a file the user opens.
const PREVIEW_LIMIT = { image: 8 * 1024 * 1024, video: 32 * 1024 * 1024, audio: 24 * 1024 * 1024, document: 8 * 1024 * 1024, other: 1024 * 1024 }

const KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'],
  video: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.wmv'],
  audio: ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.opus'],
  document: ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.txt', '.md', '.csv', '.html', '.htm', '.json', '.xml', '.yml', '.yaml'],
}
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([kind, list]) => list.map(ext => [ext, kind])))

const MIME_OF = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.xml': 'application/xml', '.yml': 'text/yaml', '.yaml': 'text/yaml',
}

// Folders that are never worth walking: dependencies, VCS internals, system drop-offs.
const SKIP = new Set(['node_modules', '.git', '.svn', '$recycle.bin', 'system volume information', '__pycache__', '.dsh', '.66ai-bot'])
const skipEntry = name => SKIP.has(name.toLowerCase()) || name.startsWith('.')

export function install(rt) {
  const { ctx, state } = rt

  const teamFolder = () => ctx.workspaceRegistry.get?.(state.workspaceId)?.path
    ?? rt.config.workspace
    ?? (process.env.AIBOT_WORKSPACE?.trim() || undefined)

  // The folders a team's files may come from: the workspace, every project's folder,
  // every Bot's working folder. Real paths, deduplicated, existing ones only.
  async function roots() {
    const candidates = [teamFolder(), ...Object.values(state.projects ?? {}).map(project => project.folder),
      ...Object.values(state.bots).map(bot => bot.workDir)].filter(Boolean)
    const found = []
    for (const candidate of candidates) {
      const real = await realpath(candidate).catch(() => undefined)
      if (real === undefined) continue
      const info = await stat(real).then(entry => entry.isDirectory(), () => false)
      if (!info) continue
      if (found.some(kept => within(kept, real) || within(real, kept))) continue
      found.push(real)
    }
    // The app's own data is never a source, even when a folder sits inside it by mistake.
    const dataRoots = [rt.dshHome, rt.home].filter(Boolean)
    return found.filter(root => !dataRoots.some(data => within(root, data)))
  }

  const kindOf = path => KIND_OF.get(extname(path).toLowerCase()) ?? 'other'

  // One entry per file, deepest-first pruning, hard cap so a huge workspace still answers.
  async function collect() {
    const allowed = await roots()
    const files = []
    const walk = async (root, depth) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return
        if (skipEntry(entry.name)) continue
        const path = join(root, entry.name)
        if (entry.isDirectory()) {
          await walk(path, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const info = await stat(path).catch(() => undefined)
        if (info === undefined || !info.isFile()) continue
        files.push({
          path,
          name: entry.name,
          ext: extname(entry.name).toLowerCase(),
          kind: kindOf(entry.name),
          size: info.size,
          mtime: Math.round(info.mtimeMs),
          folder: root,
        })
      }
    }
    await Promise.all(allowed.map(root => walk(root, 0)))
    return { allowed, files }
  }

  async function assetsView({ kinds, limit = 600 } = {}) {
    const wanted = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds.filter(kind => typeof kind === 'string')) : null
    const { allowed, files } = await collect()
    const picked = files
      .filter(file => wanted === null || wanted.has(file.kind))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(1, Math.min(Number(limit) || 600, 2000)))
    return { roots: allowed, total: files.length, entries: picked }
  }

  // A preview: the file's bytes as base64, only when the path sits in a scanned root
  // and the file is small enough for the kind. Anything bigger stays "open the folder".
  async function assetRead({ path } = {}) {
    if (typeof path !== 'string' || path === '') throw new Error('Name the file to preview')
    const allowed = await roots()
    const real = await realpath(path).catch(() => undefined)
    if (real === undefined) throw new Error('There is no file there')
    if (!allowed.some(root => within(real, root))) throw new Error('This file is outside the team folders, so it cannot be previewed here')
    const info = await stat(real).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error('There is no file there')
    const kind = kindOf(real)
    const cap = PREVIEW_LIMIT[kind] ?? PREVIEW_LIMIT.other
    if (info.size > cap) throw new Error(`This ${kind} is too large to preview (${Math.round(info.size / (1024 * 1024))} MB); open its folder instead`)
    const data = (await readFile(real)).toString('base64')
    const mime = MIME_OF[extname(real).toLowerCase()] ?? 'application/octet-stream'
    return { name: basename(real), kind, mime, size: info.size, mtime: Math.round(info.mtimeMs), data }
  }

  // Reveal a file or folder in the file manager, through the project module's spawner.
  async function assetReveal({ path } = {}) {
    if (typeof path !== 'string' || path === '') throw new Error('Name the file to reveal')
    const allowed = await roots()
    const real = await realpath(path).catch(() => undefined)
    if (real === undefined) throw new Error('There is no file there')
    if (!allowed.some(root => within(real, root))) throw new Error('This file is outside the team folders')
    rt.revealPath?.(real)
    return { ok: true }
  }

  rt.assetsView = assetsView
  rt.assetRead = assetRead
  rt.assetReveal = assetReveal
  rt.assetRoots = roots
}
