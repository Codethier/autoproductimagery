// https://nuxt.com/docs/api/configuration/nuxt-config

// Node 22+ ships an experimental `localStorage` global. When enabled without a
// valid --localstorage-file path, any call throws. @vue/devtools-kit only
// guards against `typeof localStorage === "undefined"`, so SSR crashes during
// timeline init. Null it out before any module loads so the guard passes.
try {
    if (typeof (globalThis as any).localStorage !== 'undefined') {
        Object.defineProperty(globalThis, 'localStorage', {
            value: null,
            configurable: true,
            writable: true,
        })
    }
    if (typeof (globalThis as any).sessionStorage !== 'undefined') {
        Object.defineProperty(globalThis, 'sessionStorage', {
            value: null,
            configurable: true,
            writable: true,
        })
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