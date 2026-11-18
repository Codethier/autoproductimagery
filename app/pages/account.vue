<script setup lang="ts">
import {ChangeAccountPasswordSchema} from '~~/schemas/accounts'
import {serverOrKeyMessage, uiMessageText, type UiMessage} from '../utils/uiMessage'
definePageMeta({layout: 'workspace', colorMode: 'dark'})
const session = useAccount()
const accountBalance = useAccountBalance()
const {t} = useI18n()
const form = reactive({currentPassword: '', newPassword: '', confirmation: ''})
const saving = ref(false)
// Client messages keep their key; server explanations are shown as returned.
const failure = ref<UiMessage | null>(null)
const errorMessage = computed(() => uiMessageText(failure.value, (key, params) => t(key, params ?? {})))
async function changePassword() {
  if (saving.value) return
  failure.value = null
  const parsed = ChangeAccountPasswordSchema.safeParse({currentPassword: form.currentPassword, newPassword: form.newPassword})
  if (form.newPassword !== form.confirmation) { failure.value = {key: 'account.profile.mismatch'}; return }
  if (!parsed.success) { failure.value = {key: parsed.error.issues[0]?.path[0] === 'currentPassword' ? 'account.profile.invalidCurrent' : 'account.profile.invalidNew'}; return }
  saving.value = true
  const epoch = session.epoch.value
  try {
    await $fetch('/api/account/password', {method: 'POST', body: {currentPassword: form.currentPassword, newPassword: form.newPassword}})
    if (epoch !== session.epoch.value) return
    form.currentPassword = ''; form.newPassword = ''; form.confirmation = ''
    session.clear()
    session.notifyTabs()
    await navigateTo('/login', {replace: true})
  } catch (error) {
    if (epoch === session.epoch.value) failure.value = serverOrKeyMessage(error, 'account.profile.changeFailed')
  } finally { saving.value = false }
}
useHead({title: computed(() => t('account.profile.pageTitle'))})
</script>
<template>
  <div class="workspace-page account-page">
    <div class="workspace-page-heading"><div><span class="workspace-eyebrow">{{ t('account.profile.eyebrow') }}</span><h1>{{ t('common.layout.passwordAndAccount') }}</h1><p>{{ session.account.value?.displayName }} · {{ session.account.value?.username }} · {{ session.account.value?.organizationName }}</p></div></div>
    <AccountBalanceSummary :balance="accountBalance.balance.value" :pending="accountBalance.pending.value" :error="accountBalance.error.value" @refresh="accountBalance.refresh()" />
    <AccountPaymentHistory class="account-payment-history" @balance="accountBalance.refresh()" />
    <form class="workspace-panel" @submit.prevent="changePassword"><h2>{{ t('account.profile.changeTitle') }}</h2><p>{{ t('account.profile.changeHelp') }}</p><div class="account-fields"><label class="workspace-field">{{ t('account.profile.currentPassword') }}<input v-model="form.currentPassword" type="password" autocomplete="current-password" required maxlength="1024" /></label><label class="workspace-field">{{ t('account.profile.newPassword') }}<input v-model="form.newPassword" type="password" autocomplete="new-password" required minlength="10" maxlength="256" /></label><label class="workspace-field">{{ t('account.profile.confirmPassword') }}<input v-model="form.confirmation" type="password" autocomplete="new-password" required minlength="10" maxlength="256" /></label></div><div v-if="errorMessage" role="alert" class="workspace-inline-error">{{ errorMessage }}</div><div class="workspace-form-actions"><button class="workspace-button" type="submit" :disabled="saving">{{ saving ? t('account.profile.changing') : t('account.profile.submit') }}</button></div></form>
  </div>
</template>
<style scoped>.account-page{max-width:850px}.account-fields{display:grid;gap:18px;margin-top:28px;max-width:430px}.account-page>form,.account-payment-history{margin-top:28px}</style>
