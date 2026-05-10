type ModelInfo = { id: string; name: string; displayName: string; description?: string }

// Simple in-memory cache so we don't hit the API on every page load.
let cache: { at: number; items: ModelInfo[] } | null = null
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

function stripPrefix(name: string) {
  return name?.startsWith('models/') ? name.slice('models/'.length) : name
}

function isImageGenModel(m: any): boolean {
  const name: string = (m?.name || '').toLowerCase()
  const display: string = (m?.displayName || '').toLowerCase()
  const desc: string = (m?.description || '').toLowerCase()
  const actions: string[] = (m?.supportedGenerationMethods || m?.supportedActions || [])
    .map((s: string) => s.toLowerCase())

  // Accept if API explicitly reports an image-generation action.
  if (actions.some(a => a.includes('generateimage') || a === 'predict')) return true

  // Name-based heuristic for Gemini image preview + Imagen families.
  if (/imagen/.test(name) || /imagen/.test(display)) return true
  if (/image/.test(name) && /(preview|gemini|nano)/.test(name)) return true

  // Some models describe themselves as image generation in the description.
  if (/image generation/.test(desc)) return true

  return false
}

type ListModelsResponse = {
  models?: Array<{
    name?: string
    displayName?: string
    description?: string
    supportedGenerationMethods?: string[]
  }>
  nextPageToken?: string
}

export default defineEventHandler(async (event) => {
  useAuth(event)

  const q = getQuery(event) as { refresh?: string }
  const force = q.refresh === '1' || q.refresh === 'true'

  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ok: true, items: cache.items, cached: true }
  }

  const runtimeConfig = useRuntimeConfig()
  const apiKey = runtimeConfig.GeminiApiKey
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: 'Gemini API key is missing in runtimeConfig.GeminiApiKey' })
  }

  const items: ModelInfo[] = []
  try {
    let pageToken: string | undefined = undefined
    do {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
      url.searchParams.set('pageSize', '100')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const res = await $fetch<ListModelsResponse>(url.toString(), {
        headers: { 'x-goog-api-key': apiKey },
      })
      for (const m of res.models || []) {
        if (!isImageGenModel(m)) continue
        const id = stripPrefix(m.name || '')
        if (!id) continue
        items.push({
          id,
          name: m.name || id,
          displayName: m.displayName || id,
          description: m.description,
        })
      }
      pageToken = res.nextPageToken
    } while (pageToken)
  } catch (e: any) {
    throw createError({ statusCode: 502, statusMessage: `Failed to list Gemini models: ${e?.message || e}` })
  }

  // Deduplicate by id and sort for stable order.
  const seen = new Set<string>()
  const deduped = items.filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)))
  deduped.sort((a, b) => a.id.localeCompare(b.id))

  cache = { at: Date.now(), items: deduped }
  return { ok: true, items: deduped, cached: false }
})
