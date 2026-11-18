<script setup lang="ts">
import {object, string} from 'yup'
import {fetchStatusCode, serverlessFetchOptions} from '../utils/serverlessRequests'
const route = useRoute()
const router = useRouter()
const session = useAccount()
const {t} = useI18n()
const loading = ref(false)
// Store the message key so the alert follows a runtime language switch.
const errorKey = ref('')
const form = reactive({username: '', password: ''})
const schema = computed(() => object({username: string().required(t('account.login.usernameRequired')), password: string().required(t('account.login.passwordRequired'))}))
async function onSubmit() {
  if (loading.value) return
  loading.value = true
  errorKey.value = ''
  session.clear()
  const epoch = session.epoch.value
  try {
    const ok = await $fetch('/api/login', serverlessFetchOptions({method: 'POST', body: {username: form.username, password: form.password}}, epoch))
    if (epoch !== session.epoch.value) return
    if (ok !== true) throw new Error('Invalid credentials')
    await session.load()
    if (epoch !== session.epoch.value) return
    form.password = ''
    session.notifyTabs()
    const requestedTarget = typeof route.query.redirect === 'string' ? route.query.redirect : '/edit'
    const target = requestedTarget.startsWith('/') && !requestedTarget.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(requestedTarget) ? requestedTarget : '/edit'
    await router.replace(target)
  } catch (error) {
    if (epoch === session.epoch.value) errorKey.value = fetchStatusCode(error) === 401 ? 'account.login.invalidCredentials' : 'account.login.unavailable'
  } finally { loading.value = false }
}
useHead({title: computed(() => t('account.login.pageTitle'))})
</script>

<template>
  <div class="studio-login">
    <div class="studio-login-language"><LanguageSwitcher /></div>
    <section class="studio-login-intro" aria-hidden="true">
      <span class="studio-login-brand"><UIcon name="i-lucide-aperture" />{{ t('common.appName') }}</span>
      <div><span class="workspace-eyebrow">{{ t('account.login.introEyebrow') }}</span><h2>{{ t('account.login.introHeadingLine1') }}<br>{{ t('account.login.introHeadingLine2') }}</h2><p>{{ t('account.login.introBody') }}</p></div>
      <span class="studio-login-geometry"><i/><i/><i/></span>
    </section>
    <section class="studio-login-form">
      <span class="workspace-eyebrow">{{ t('account.login.eyebrow') }}</span><h1>{{ t('account.login.title') }}</h1><p>{{ t('account.login.subtitle') }}</p>
      <UForm :state="form" :schema="schema" @submit="onSubmit" class="studio-login-fields">
        <UFormField :label="t('account.login.username')" name="username" required><UInput v-model="form.username" class="w-full" :placeholder="t('account.login.usernamePlaceholder')" autocomplete="username" autofocus /></UFormField>
        <UFormField :label="t('account.login.password')" name="password" required><UInput v-model="form.password" class="w-full" type="password" :placeholder="t('account.login.passwordPlaceholder')" autocomplete="current-password" /></UFormField>
        <p v-if="errorKey" role="alert" class="workspace-inline-error">{{ t(errorKey) }}</p>
        <p v-if="loading" role="status" class="studio-login-wait">{{ t('account.login.waiting') }}</p>
        <UButton type="submit" color="primary" :loading="loading" block>{{ t('account.login.submit') }}<UIcon name="i-lucide-arrow-right" /></UButton>
      </UForm>
    </section>
  </div>
</template>

<style scoped>
.studio-login-wait{font-size:12px;color:var(--workspace-muted);line-height:1.6}
.studio-login-language{position:absolute;top:20px;right:24px;z-index:2}
.studio-login{position:relative;min-height:100dvh;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(420px,1fr);background:var(--workspace-bg)}.studio-login-intro{position:relative;overflow:hidden;background:#302b22;padding:45px 60px;display:flex;flex-direction:column;justify-content:space-between;min-height:100dvh;border-right:1px solid var(--workspace-border)}.studio-login-brand{display:flex;gap:12px;align-items:center;font-size:15px;font-weight:600}.studio-login-brand .iconify{font-size:30px;color:var(--workspace-accent)}.studio-login-intro>div{z-index:1;margin-top:auto;margin-bottom:23vh}.studio-login-intro h2{font-size:clamp(36px,4vw,64px);font-weight:400;line-height:1.1;letter-spacing:-2px;font-family:Georgia,serif}.studio-login-intro p{font-size:14px;color:#c3b5a1;max-width:400px;line-height:1.8;margin-top:24px}.studio-login-geometry{position:absolute;bottom:-280px;right:-170px;width:680px;height:680px;transform:rotate(-20deg)}.studio-login-geometry i{position:absolute;inset:0;border:1px solid #b78c5750;border-radius:42%;transform:rotate(25deg)}.studio-login-geometry i:nth-child(2){inset:50px;transform:rotate(10deg)}.studio-login-geometry i:nth-child(3){inset:100px;transform:rotate(-5deg)}.studio-login-form{width:min(470px,100%);padding:50px;align-self:center;justify-self:center}.studio-login-form h1{font-size:32px;font-weight:550;letter-spacing:-.7px}.studio-login-form>p{font-size:13px;line-height:1.7;color:var(--workspace-muted);margin-top:12px}.studio-login-fields{display:grid;gap:20px;margin-top:32px}.studio-login-fields button{margin-top:8px;min-height:42px;color:#241c15}
@media(max-width:760px){.studio-login{grid-template-columns:1fr}.studio-login-intro{display:none}.studio-login-form{padding:36px 25px}}
</style>
