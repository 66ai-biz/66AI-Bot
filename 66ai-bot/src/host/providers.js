// Model providers and their API keys, for a window that has no DSH Models page of its
// own. DSH keeps all of it: a provider route in the settings of the adapter that serves
// it, the route's key in DSH's credential store under the reference the route names.
// The providers to add are the ones DSH's directory of configurable providers offers.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PI_AI = 'llm-pi-ai'
const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
// The wire protocols DSH's pi-ai adapter serves on a route it ships nothing about.
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const MAX_MODELS = 500

// Providers that come preset for a fresh setup: the 66AI relay with the models it
// serves. The relay key ships with the installer (preset-key.local next to this
// module, never in the repository); a key the user set themselves always wins.
const BUILTIN_PROVIDERS = [
  {
    provider: 'ai66',
    name: '66ai',
    api: 'openai-completions',
    baseURL: 'https://api.66ai.biz/v1',
    models: [
      { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3' },
      { id: 'minimaxai/minimax-m3.1-flash', name: 'MiniMax M3.1' },
      { id: 'stepfun-ai/step-5-preview', name: 'Step 5' },
      { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1' },
      { id: 'mistralai/mistral-large-4-1t-a52b', name: 'Mistral Large 4' },
      { id: 'meta/muse-glimmer-30b', name: 'Muse Glimmer' },
    ],
  },
]

// The API key a preset provider ships with, read from a `preset-key.local` file the
// repository ignores. Two homes: the app's data dir (the key the cloud handed the
// signed-in account, kept current by the app) first, then the file beside this module
// (a key baked in at packaging time). '' when neither is there.
function presetKey(provider) {
  if (!BUILTIN_PROVIDERS.some(item => item.provider === provider)) return ''
  const homes = [
    ...(process.env.DSH_HOME ? [join(process.env.DSH_HOME, 'preset-key.local')] : []),
    join(dirname(fileURLToPath(import.meta.url)), 'preset-key.local'),
  ]
  for (const file of homes) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed?.key === 'string' && parsed.key.trim() !== '') return parsed.key.trim()
    } catch { /* this home has none; try the next */ }
  }
  return ''
}

// The reference DSH's own Models page derives for a route's key, so a provider added
// here and one added there read the same key.
export const keyRefFor = provider => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// What an HTTP header can carry, like DSH's own key check: a pasted `NAME=value` line
// or a quoted value would be stored as the key and refused by the provider.
export function checkKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key === '') throw invalid('Enter the API key')
  if (/^[A-Za-z_][A-Za-z0-9_]*=[^=]/.test(key)) throw invalid('Paste only the key, not a NAME=value line')
  if (/^(["']).*\1$/.test(key)) throw invalid('Paste the key without quotes')
  if (!/^[\x21-\x7E]+$/.test(key)) throw invalid('An API key has no spaces or special characters')
  return key
}

function checkEndpoint(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  let url
  try { url = new URL(text) } catch { throw invalid('Enter the endpoint as an http or https address') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Enter the endpoint as an http or https address')
  return text
}

// A model as the route stores it: what discovery told about it, under pi-ai's names.
function modelEntry(model) {
  const id = typeof model === 'string' ? model.trim() : typeof model?.id === 'string' ? model.id.trim() : ''
  if (id === '') throw invalid('Every model needs an id')
  const whole = value => (Number.isInteger(value) && value > 0 ? value : undefined)
  return {
    id,
    ...(typeof model?.name === 'string' && model.name.trim() !== '' ? { name: model.name.trim() } : {}),
    ...(whole(model?.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(whole(model?.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    ...(Array.isArray(model?.inputModalities) && model.inputModalities.length > 0 ? { input: model.inputModalities.filter(kind => typeof kind === 'string') } : {}),
  }
}

export function install(rt) {
  const { ctx } = rt

  const seams = () => {
    const settings = ctx.get?.('settings')
    const credentials = ctx.get?.('credentials')
    return settings && credentials && ctx.llm.listConfigurableProviders ? { settings, credentials } : undefined
  }
  const usable = () => {
    const found = seams()
    if (found === undefined) throw invalid('This DSH cannot set up model providers')
    return found
  }
  const sections = settings => new Map(settings.describe({ redactSecrets: true }).map(section => [section.ns, section]))
  const profileOf = (entry, map, layer = 'value') => entry.settingsPath.reduce((value, key) => value?.[key], map.get(entry.settingsNs)?.[layer])
  const refOf = profile => (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : undefined)
  const entryOf = provider => ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)

  // Per provider route, the credential its DSH settings name as its API key. A
  // provider with none authenticates some other way.
  function keyRefs() {
    const found = seams()
    if (found === undefined) return new Map()
    const map = sections(found.settings)
    const refs = new Map()
    for (const entry of ctx.llm.listConfigurableProviders()) {
      const ref = refOf(profileOf(entry, map))
      if (ref !== undefined) refs.set(entry.provider, ref)
    }
    return refs
  }

  async function missingKeys(providers) {
    let refs
    try { refs = keyRefs() } catch { return new Set() }
    const missing = new Set()
    await Promise.all(providers.filter(id => refs.has(id)).map(async (id) => {
      const info = await seams().credentials.describe(refs.get(id)).catch(() => undefined)
      if (info?.configured === false) missing.add(id)
    }))
    return missing
  }

  // The providers set up in DSH, with their models and key state, and the ones DSH
  // can add. A provider with no key and no models (DeepSeek's account route before a
  // sign-in) is left out.
  async function providersView() {
    await ensureBuiltinProviders()
    const found = seams()
    if (found === undefined) return { available: false }
    const map = sections(found.settings)
    const catalog = await rt.catalog({ fresh: true })
    const providers = []
    const addable = []
    for (const entry of ctx.llm.listConfigurableProviders()) {
      const profile = profileOf(entry, map)
      if (entry.settingsNs === PI_AI && profile === undefined) {
        if (entry.declared !== true) addable.push({ id: entry.provider, name: entry.displayName })
        continue
      }
      const ref = refOf(profile)
      const models = catalog.filter(model => model.provider === entry.provider).map(model => ({ ref: model.ref, name: model.name }))
      if (ref === undefined && models.length === 0 && entry.error === undefined) continue
      const info = ref === undefined ? undefined : await found.credentials.describe(ref).catch(() => undefined)
      providers.push({
        id: entry.provider,
        name: entry.displayName,
        models,
        key: ref === undefined ? null : { configured: info?.configured === true, writable: info?.writable !== false },
        removable: entry.settingsNs === PI_AI && profileOf(entry, map, 'user') !== undefined && profileOf(entry, map, 'base') === undefined,
        custom: entry.declared === true,
        ...(entry.error ? { error: entry.error } : {}),
      })
    }
    // The ones that come with the setup first, then the added ones as DSH lists them.
    providers.sort((a, b) => Number(a.removable) - Number(b.removable))
    return { available: true, providers, addable, protocols: PROTOCOLS }
  }

  async function writableRef(provider) {
    const ref = keyRefs().get(provider)
    if (ref === undefined) throw invalid(`${provider} takes no API key here`)
    if ((await usable().credentials.describe(ref)).writable === false) throw invalid(`The API key for ${provider} is set outside 66AI Bot and cannot be changed here`)
    return ref
  }

  // A key is only ever written; nothing here reads one back.
  async function setProviderKey(provider, value) {
    const key = checkKey(value)
    await usable().credentials.set(await writableRef(provider), key)
    rt.dropCatalog()
  }

  async function clearProviderKey(provider) {
    await usable().credentials.unset(await writableRef(provider))
    rt.dropCatalog()
  }

  // `provider` from DSH's directory, or a route the user declares (`custom`) for an
  // endpoint DSH ships nothing about. The route goes in first, then its key, as DSH's
  // own Models page does it: a failed key write leaves a provider that asks for one.
  async function addProvider(body) {
    const { settings, credentials } = usable()
    const provider = String(body.provider ?? '').trim()
    const map = sections(settings)
    const entry = entryOf(provider)
    if (entry !== undefined && (entry.settingsNs !== PI_AI || profileOf(entry, map) !== undefined)) throw invalid(`${provider} is already set up`)
    const custom = body.custom === true
    if (!custom && (entry === undefined || entry.declared === true)) throw invalid(`DSH offers no provider ${provider}`)
    if (custom && !ROUTE_ID.test(provider)) throw invalid('A provider id is lowercase letters, digits and dashes, starting with a letter')
    if (custom && entry !== undefined) throw invalid(`DSH already offers ${provider}; add it from its list`)
    const key = typeof body.key === 'string' && body.key.trim() !== '' ? checkKey(body.key) : undefined
    const ref = keyRefFor(provider)
    const info = await credentials.describe(ref)
    if (key !== undefined && info.writable === false) throw invalid(`The API key for ${provider} is set outside 66AI Bot and cannot be changed here`)
    // A blank key keeps a key that is already there, else the provider's own sign-in.
    const keyed = key !== undefined || info.configured === true
    const profile = custom ? customProfile(body) : {}
    if (keyed) profile.apiKeyEnv = ref
    await settings.mutate(PI_AI, [{ op: 'set', path: entry?.settingsPath ?? ['providers', provider], value: profile }], map.get(PI_AI)?.revision)
    if (key !== undefined) await credentials.set(ref, key)
    rt.dropCatalog()
    return providersView()
  }

  function customProfile(body) {
    if (!PROTOCOLS.includes(body.api)) throw invalid(`The protocol must be one of ${PROTOCOLS.join(', ')}`)
    const models = Array.isArray(body.models) ? body.models.slice(0, MAX_MODELS).map(modelEntry) : []
    if (models.length === 0) throw invalid('Add at least one model')
    if (new Set(models.map(model => model.id)).size !== models.length) throw invalid('Two models have the same id')
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
    return { ...(name ? { displayName: name } : {}), api: body.api, baseURL: checkEndpoint(body.baseURL), models }
  }

  // The models an endpoint (or a provider DSH ships) says it serves. The key typed for
  // the question goes with it and is not stored.
  async function discoverModels(body) {
    usable()
    const provider = typeof body.provider === 'string' && body.provider !== '' ? body.provider : undefined
    const request = provider !== undefined && entryOf(provider)?.declared === false
      ? { provider }
      : {
          baseURL: checkEndpoint(body.baseURL),
          ...(PROTOCOLS.includes(body.api) ? { api: body.api } : {}),
          ...(typeof body.key === 'string' && body.key.trim() !== '' ? { apiKey: checkKey(body.key) } : {}),
        }
    const models = await ctx.llm.discoverModels(PI_AI, request)
    return models.slice(0, MAX_MODELS).map(model => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
    }))
  }

  // Only a route the user added goes; its key goes with it when it is the one this page
  // derives and no other provider names it.
  async function removeProvider(provider) {
    const { settings, credentials } = usable()
    const map = sections(settings)
    const entry = entryOf(provider)
    if (entry === undefined || entry.settingsNs !== PI_AI || profileOf(entry, map) === undefined) throw invalid(`${provider} is not set up`)
    if (profileOf(entry, map, 'user') === undefined || profileOf(entry, map, 'base') !== undefined) throw invalid(`${provider} comes with this setup and cannot be removed`)
    const ref = refOf(profileOf(entry, map))
    const shared = [...keyRefs()].some(([other, otherRef]) => other !== provider && otherRef === ref)
    await settings.mutate(PI_AI, [{ op: 'unset', path: entry.settingsPath }], map.get(PI_AI)?.revision)
    if (ref === keyRefFor(provider) && !shared) {
      const info = await credentials.describe(ref)
      if (info.configured && info.writable) await credentials.unset(ref)
    }
    rt.dropCatalog()
    return providersView()
  }

  // A fresh setup gets the preset providers automatically; whatever the user already
  // has stays as it is. A preset lands only when genuinely missing, its route always
  // names the key reference it would use (so its models honestly ask for a key until
  // one is there), and the shipped key — a file the app keeps current — lands when no
  // key is configured yet. A failure here never blocks a view. A host opts out with
  // `builtinProviders: false`.
  const addPreset = async (item, ref, key, map) => {
    const { settings, credentials } = usable()
    const profile = { displayName: item.name, api: item.api, baseURL: checkEndpoint(item.baseURL), models: item.models.map(modelEntry), apiKeyEnv: ref }
    await settings.mutate(PI_AI, [{ op: 'set', path: ['providers', item.provider], value: profile }], map.get(PI_AI)?.revision)
    if (key !== '') await credentials.set(ref, key)
    rt.dropCatalog()
  }

  let ensuring
  function ensureBuiltinProviders() {
    const run = async () => {
      if (rt.builtinProviders === false || seams() === undefined) return
      try {
        const { settings, credentials } = usable()
        const map = sections(settings)
        const current = map.get(PI_AI)?.value?.providers ?? {}
        for (const item of BUILTIN_PROVIDERS) {
          // A provider DSH itself ships (a settings namespace of its own) stays alone;
          // a preset of ours lives as a pi-ai route and may need its key brought in.
          const entry = entryOf(item.provider)
          if (entry !== undefined && entry.settingsNs !== PI_AI) continue
          const ref = keyRefFor(item.provider)
          const held = await credentials.describe(ref).catch(() => undefined)
          const key = held?.configured === true ? '' : presetKey(item.provider)
          const profile = current[item.provider]
          if (profile === undefined) {
            await addPreset(item, ref, key, map)
            continue
          }
          // The route already stands: name the key reference when it is missing, and
          // bring the shipped key when none is configured. A key that is there wins.
          if (profile.apiKeyEnv !== ref) {
            await settings.mutate(PI_AI, [{ op: 'set', path: ['providers', item.provider], value: { ...profile, apiKeyEnv: ref } }], map.get(PI_AI)?.revision)
            rt.dropCatalog()
          }
          if (key !== '') await credentials.set(ref, key)
        }
      } catch { /* a failed preset never blocks the providers page */ }
    }
    ensuring = (ensuring ?? Promise.resolve()).catch(() => {}).then(run)
    return ensuring
  }

  Object.assign(rt, { keyRefs, missingKeys, providersView, setProviderKey, clearProviderKey, addProvider, discoverModels, removeProvider })

  // Land the presets as early as boot, so the first chat opens on a working model
  // instead of waiting for the providers page.
  ensureBuiltinProviders()
}
