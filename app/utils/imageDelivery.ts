export type ImagePreviewSize = 160 | 480 | 960 | 1600

const IMAGE_API_PREFIX = '/api/data/'

/** Stored URLs are already canonically encoded by the server. Never encode them twice. */
export function imageDownloadUrl(source: string): string {
  if (!source) return ''
  if (source.startsWith('//')) return ''
  if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
    return /^(?:https?:|data:|blob:)/i.test(source) ? source : ''
  }

  const url = source.startsWith('/api/')
    ? source
    : `/api/data${source.startsWith('/') ? source : `/${source}`}`
  if (!url.startsWith(IMAGE_API_PREFIX)) return url

  // A preview may be passed by a caller, but downloads always use the original.
  const hashIndex = url.indexOf('#')
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex)
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  if (queryIndex === -1) return url
  const query = new URLSearchParams(beforeHash.slice(queryIndex + 1))
  query.delete('preview')
  const remaining = query.toString()
  return `${beforeHash.slice(0, queryIndex)}${remaining ? `?${remaining}` : ''}${hash}`
}

/** Display a bounded preview; local data/blob URLs retain their existing behavior. */
export function imagePreviewUrl(source: string, size: ImagePreviewSize = 480): string {
  const original = imageDownloadUrl(source)
  if (!original.startsWith(IMAGE_API_PREFIX)) return original
  const hashIndex = original.indexOf('#')
  const hash = hashIndex === -1 ? '' : original.slice(hashIndex)
  const beforeHash = hashIndex === -1 ? original : original.slice(0, hashIndex)
  return `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}preview=${size}${hash}`
}
