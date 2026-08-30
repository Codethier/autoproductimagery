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
         imageGenerationConcurrency: 3,
         imageGenerationMaxQueue: 25,
         imageGenerationTimeoutMs: 180_000,
         imageGenerationStaleTtlMs: 15 * 60_000,
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
    modules: ['@nuxt/image', '@nuxt/scripts', '@nuxt/ui', '@pinia/nuxt'],
    css: [
        '~/assets/css/main.css',
        // 'vue-json-pretty/lib/styles.css'
    ],
    icon: {
        // npm package with all icons: "@iconify/json": "^2.2.232",
        //     removed it because the build needed too much ram and didn't build...
        serverBundle: 'remote',
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
