// A corrupt overlay must not brick the app: DSH refuses to boot when a patch
// file exists but does not parse (the seen failure mode is a zero-filled
// `cordis.patch.yml`), while a MISSING patch file boots fine — the user layer
// is optional and the built-in model preset re-applies on boot. So before the
// Host spawns, every patch file DSH would parse is checked; one that fails to
// parse (or carries a raw NUL byte, which no YAML stream may contain) is
// renamed next to itself with a `.corrupt-<stamp>` suffix, keeping the bytes
// for inspection and letting the boot start clean.
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const pad = value => String(value).padStart(2, '0')

/** A local-time stamp for quarantine archives: 20261031-154812. */
export function corruptStamp(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Whether the file's bytes cannot be a patch DSH would parse. */
function broken(content) {
  // A raw NUL byte is illegal in a YAML stream under any schema; the seen
  // corruption is a whole zero-filled file. Parse catches every other shape.
  if (content.includes('\u0000')) return 'the file carries a NUL byte'
  try {
    parse(content)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Every patch file DSH parses for this home: the home-level user layer, each
 * profile's user layer, and the app's own overlay patches beside the profiles.
 * @param {string} home - the app's data dir (DSH_HOME).
 * @returns {string[]} absolute patch-file paths that exist.
 */
export function patchFilesIn(home) {
  const files = [join(home, 'cordis.patch.yml')]
  const profilesDir = join(home, 'profiles')
  if (existsSync(profilesDir)) {
    files.push(join(profilesDir, 'office.patch.yml'), join(profilesDir, 'search-selector.patch.yml'))
    let entries = []
    try { entries = readdirSync(profilesDir, { withFileTypes: true }) } catch { entries = [] }
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(join(profilesDir, entry.name, 'cordis.patch.yml'))
    }
  }
  return files.filter(file => existsSync(file))
}

/**
 * Quarantine unparseable patch files under `home` before the Host reads them.
 * @param {string} home - the app's data dir (DSH_HOME).
 * @param {{ now?: Date, rename?: typeof renameSync }} [options] - the clock and the mover, for tests.
 * @returns {{ file: string, archive: string, reason: string }[]} what was quarantined.
 */
export function quarantineBrokenPatches(home, { now = new Date(), rename = renameSync } = {}) {
  const moved = []
  for (const file of patchFilesIn(home)) {
    let content
    try { content = readFileSync(file, 'utf8') } catch (error) {
      console.error(`66AI Bot: could not read the patch file ${file}`, error)
      continue
    }
    const reason = broken(content)
    if (reason === undefined) continue
    const archive = `${file}.corrupt-${corruptStamp(now)}`
    try {
      rename(file, archive)
    } catch (error) {
      // The file stays; the Host still fails, but the next start tries again.
      console.error(`66AI Bot: could not quarantine the broken patch file ${file}`, error)
      continue
    }
    console.warn(`66AI Bot: quarantined a broken patch file ${file} -> ${archive} (${reason})`)
    moved.push({ file, archive, reason })
  }
  return moved
}
