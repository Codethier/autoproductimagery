// https://nuxt.com/docs/api/configuration/nuxt-config

// Node 22+ ships an experimental `localStorage` global. When enabled without a
// valid --localstorage-file path, any call throws. @vue/devtools-kit only
// guards against `typeof localStorage === "undefined"`, so SSR crashes during
// timeline init. Null it out before any module loads so the guard passes.
try {
    for (const storageName of ['localStorage', 'sessionStorage'] as const) {
        // Reading Node's experimental getter emits a warning before Nuxt even
        // starts. Inspect the descriptor and replace it without invoking it.
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, storageName)
        if (!descriptor || descriptor.configurable) {
            Object.defineProperty(globalThis, storageName, {
                value: null,
                configurable: true,
                writable: true,
            })
        }
    }
} catch { /* no-op */ }

// One message file per UI area, merged for each locale. Keep both locales in
// sync; tests/i18n-locales.test.ts checks that every key exists in both.
const I18N_NAMESPACES = ['common', 'account', 'generation', 'models', 'library', 'people', 'pipelines', 'pipelineEditor']

export default defineNuxtConfig({
    future: {
        compatibilityVersion: 4,

    },
    experimental: {
        componentIslands: true
    },
    // debug: true,
    runtimeConfig: {
        //         private
         AiGatewayApiKey: '',
         authUser: '',
         authPassword: '',
         authSessionSecret: '',
         imageGenerationConcurrency: 3,
         imageGenerationMaxQueue: 50,
         imageGenerationTimeoutMs: 180_000,
         imageGenerationStaleTtlMs: 15 * 60_000,
         imageGenerationRequestTimeoutMs: 270_000,
        //     public
        public: {}
    },
    compatibilityDate: '2025-07-15',
    devtools: {
        enabled: true,
        timeline: {
            enabled: true,
        },
    },
    modules: ['@nuxt/image', '@nuxt/scripts', '@nuxt/ui', '@pinia/nuxt', '@nuxtjs/i18n'],
    i18n: {
        // Routes stay language-neutral. The chosen language is a non-sensitive
        // device preference kept in its own cookie; English is the fallback.
        strategy: 'no_prefix',
        defaultLocale: 'en',
        locales: (['en', 'hu'] as const).map(code => ({
            code,
            language: code === 'en' ? 'en-US' : 'hu-HU',
            name: code === 'en' ? 'English' : 'Magyar',
            files: I18N_NAMESPACES.map(namespace => `${code}/${namespace}.json`),
        })),
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'i18n_locale',
            redirectOn: 'no prefix',
            alwaysRedirect: false,
            fallbackLocale: 'en',
        },
    },
    css: [
        '~/assets/css/main.css',
        // 'vue-json-pretty/lib/styles.css'
    ],
    icon: {
        // Bundle only the two collections used by this app, so workspace
        // controls render on cold starts without a remote icon CDN request.
        serverBundle: {collections: ['lucide', 'heroicons']},
        fallbackToApi: false,
    },
    ui: {
        // icons:['heroicons','openmoji','line-md','wpf']
        // icons: 'all',
        // @ts-ignore
        notifications: {
            // Show toasts at the top right of the screen
            position: 'top-0 bottom-auto'
        }
    },
})
