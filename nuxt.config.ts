// https://nuxt.com/docs/api/configuration/nuxt-config
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
        GeminiApiKey: '',
        authUser: '',
        authPassword: '',
        //     public
        public: {
            GeminiModels: {
                gemini25FlashIOImagePreview: 'gemini-2.5-flash-image-preview'
            }
        }
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