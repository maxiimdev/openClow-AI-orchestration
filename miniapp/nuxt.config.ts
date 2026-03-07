import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: [
    '@pinia/nuxt',
    '@nuxt/eslint',
  ],

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    // Server-only keys (never exposed to client).
    // Override at runtime with NUXT_MINIAPP_JWT_SECRET / NUXT_TELEGRAM_BOT_TOKEN.
    miniappJwtSecret: 'dev-jwt-secret-do-not-use-in-prod',
    telegramBotToken: '',
  },

  vite: {
    plugins: [tailwindcss()],
  },
})
