// Client copy stored in refs keeps its i18n key, so a runtime language switch
// re-renders it. Server status messages are shown exactly as returned.
export type Translate = (key: string, params?: Record<string, unknown>) => string
export type UiMessage = {key: string; params?: Record<string, unknown>} | {text: string}

export function uiMessageText(message: UiMessage | null | undefined, t: Translate): string {
  if (!message) return ''
  return 'text' in message ? message.text : t(message.key, message.params ?? {})
}

export function serverStatusMessage(error: unknown): string | undefined {
  const value = (error as {data?: {statusMessage?: unknown}} | null | undefined)?.data?.statusMessage
  return typeof value === 'string' && value ? value : undefined
}

// Prefer the server's explanation; otherwise fall back to a localized key.
export function serverOrKeyMessage(error: unknown, key: string): UiMessage {
  const text = serverStatusMessage(error)
  return text ? {text} : {key}
}

// Plain utilities imported by node tests have no i18n runtime. Their English
// fallback mirrors i18n/locales/en/account.json and is used only when a caller
// does not supply the active translator.
export function fallbackTranslator(messages: Record<string, string>): Translate {
  return (key, params = {}) => (messages[key] ?? key).replace(/\{\s*([A-Za-z_]\w*)\s*\}/g, (_match, name: string) => String(params[name] ?? ''))
}
