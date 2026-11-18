// Messages live in i18n/locales/<locale>/<namespace>.json (see nuxt.config.ts).
// A missing Hungarian message falls back to English instead of showing a key.
export default defineI18nConfig(() => ({
    legacy: false,
    fallbackLocale: 'en',
    fallbackWarn: false,
    missingWarn: import.meta.dev,
}))
