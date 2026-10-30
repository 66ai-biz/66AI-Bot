// The first start: where the app keeps its data and the Bots' files, and whether it copies the
// Bot team of the user's own DSH. The answers are kept in the app's own data.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { installFolder } from './move-data.mjs'

const TEXT = {
  en: {
    welcome: 'Welcome to 66AI Bot',
    places: (data, workspace) => `Data: ${data}\nTeam workspace: ${workspace}`,
    start: 'Start', change: 'Change…',
    pickData: 'Folder for 66AI Bot data', pickWorkspace: 'Folder for the team workspace',
    dataInWorkspace: 'The data folder cannot be inside the team workspace.',
    workspaceInData: 'The team workspace cannot be inside the data folder.',
    inDsh: home => `Choose a folder outside the DSH data (${home}).`,
    inProgram: 'Choose a folder outside the program folder: uninstalling removes it.',
    pickMove: 'New folder for 66AI Bot data',
    moveDrive: 'Choose a folder, not a whole drive.',
    moveNested: 'Choose a folder outside the current data folder.',
    moveWorkspace: 'The data folder and the team workspace cannot hold each other.',
    moveNotEmpty: 'Choose an empty folder or a new one.',
    moveConfirm: to => `Move 66AI Bot's data to ${to}?`,
    moveDetail: from => `66AI Bot copies its data there and starts again. ${from} stays as it is; you can delete it once everything works.`,
    move: 'Move and restart', cancel: 'Cancel',
    moving: 'Copying 66AI Bot\'s data…',
    starting: 'Starting 66AI Bot…',
    moveInUse: 'Another DSH is using this data, so it was not moved. Close it, then try again.',
    moveFailed: message => `The data could not be copied: ${message}\n\n66AI Bot goes on with its data where it was.`,
    found: (bots, rooms) => `DSH has a Bot team: ${bots} Bot${bots === 1 ? '' : 's'}${rooms > 0 ? `, ${rooms} group${rooms === 1 ? '' : 's'}` : ''}. Copy it into 66AI Bot?`,
    foundDetail: home => `The copy takes the Bots, groups, memories, chats, files, keys and model settings. Nothing in ${home} changes, and the two teams do not stay in step.`,
    copy: 'Copy', skip: 'Do not copy',
    inUse: 'DSH is using this team. Close it, then try again.', retry: 'Try again',
    newer: count => `${count} chat${count === 1 ? ' was' : 's were'} written by a newer DSH than this 66AI Bot can read. Update 66AI Bot, then start it again to copy the team.`,
    quit: 'Quit', startEmpty: 'Start without the team',
    whichModels: 'Which model settings should 66AI Bot use?',
    failed: message => `The team could not be copied: ${message}\n\n66AI Bot starts with a new team. The team in DSH is unchanged.`,
    notStarted: '66AI Bot could not start.',
  },
  zh: {
    welcome: '欢迎使用 66AI Bot',
    places: (data, workspace) => `数据：${data}\n总工作区：${workspace}`,
    start: '开始使用', change: '更改位置…',
    pickData: '选择 66AI Bot 的数据文件夹', pickWorkspace: '选择总工作区的文件夹',
    dataInWorkspace: '数据文件夹不能放在总工作区里面。',
    workspaceInData: '总工作区不能放在数据文件夹里面。',
    inDsh: home => `请选择 DSH 数据（${home}）以外的文件夹。`,
    inProgram: '请选择程序文件夹以外的位置：卸载时会删掉程序文件夹。',
    pickMove: '选择 66AI Bot 数据的新文件夹',
    moveDrive: '请选择一个文件夹，不要选整个磁盘。',
    moveNested: '请选择现在的数据文件夹以外的位置。',
    moveWorkspace: '数据文件夹和总工作区不能互相包含。',
    moveNotEmpty: '请选择一个空文件夹，或者新建一个。',
    moveConfirm: to => `把 66AI Bot 的数据移到 ${to} 吗？`,
    moveDetail: from => `66AI Bot 会把数据复制过去，然后重新启动。${from} 会原样保留，确认一切正常后可以自己删掉。`,
    move: '移动并重启', cancel: '取消',
    moving: '正在复制 66AI Bot 的数据…',
    starting: '正在启动 66AI Bot…',
    moveInUse: '另一个 DSH 正在使用这份数据，所以没有移动。请先关掉它，再重试。',
    moveFailed: message => `数据没有复制成功：${message}\n\n66AI Bot 会继续使用原来位置的数据。`,
    found: (bots, rooms) => `DSH 里有一个 Bot 团队：${bots} 个 Bot${rooms > 0 ? `、${rooms} 个群` : ''}。要复制到 66AI Bot 吗？`,
    foundDetail: home => `会复制 Bot、群、记忆、对话、文件、密钥和模型设置。${home} 里的内容不会改变；复制以后两个团队各自独立。`,
    copy: '复制', skip: '不复制',
    inUse: 'DSH 正在使用这个团队。请先关掉它，再重试。', retry: '重试',
    newer: count => `有 ${count} 段对话是更新版本的 DSH 写的，这个版本的 66AI Bot 读不了。请先更新 66AI Bot，再打开它来复制团队。`,
    quit: '退出', startEmpty: '不带团队开始',
    whichModels: '66AI Bot 用哪一份模型设置？',
    failed: message => `团队没有复制成功：${message}\n\n66AI Bot 会用一个新团队开始。DSH 里的团队没有变化。`,
    notStarted: '66AI Bot 没能启动。',
  },
}
export const localeText = table => (app.getLocale().toLowerCase().startsWith('zh') ? table.zh : table.en)
export const text = () => localeText(TEXT)

const locationsFile = () => join(app.getPath('userData'), 'locations.json')

export const programFolder = () => installFolder(app.getPath('exe'))

/** Write the chosen places once the first run is finished; quitting before that asks again. */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  // A write that fails half way leaves the places that were there.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

/**
 * Where the app keeps its data and the Bots' files, asked at the first start.
 * A run on throwaway folders (AIBOT_HOME, for development and tests) asks nothing and copies nothing.
 * @returns {Promise<{ dataDir: string, workspace?: string, import?: { from: string, profile?: string }, quit?: true }>}
 */
export async function chooseLocations(signal) {
  if (process.env.AIBOT_HOME) return { dataDir: process.env.AIBOT_HOME, workspace: process.env.AIBOT_WORKSPACE || undefined }
  const file = locationsFile()
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return { dataDir: saved.dataDir, workspace: saved.workspace }
  }
  const t = text()
  let dataDir = join(homedir(), '.66ai-bot')
  let workspace = join(homedir(), '66AI Bot')
  // The first run goes straight to the default places: no welcome dialog, no import
  // offer. The locations stay editable from the app's own data-menu.
  saveLocations({ dataDir, workspace })
  return { dataDir, workspace }
}
