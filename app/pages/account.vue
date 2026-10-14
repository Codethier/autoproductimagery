<script setup lang="ts">
import {ChangeAccountPasswordSchema} from '~~/schemas/accounts'
definePageMeta({layout: 'workspace', colorMode: 'dark'})
const session = useAccount()
const accountBalance = useAccountBalance()
const form = reactive({currentPassword: '', newPassword: '', confirmation: ''})
const saving = ref(false)
const errorMessage = ref('')
async function changePassword() {
  if (saving.value) return
  errorMessage.value = ''
  const parsed = ChangeAccountPasswordSchema.safeParse({currentPassword: form.currentPassword, newPassword: form.newPassword})
  if (form.newPassword !== form.confirmation) { errorMessage.value = 'The new passwords do not match.'; return }
  if (!parsed.success) { errorMessage.value = parsed.error.issues[0]?.message ?? 'Check your password.'; return }
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
    if (epoch === session.epoch.value) errorMessage.value = (error as {data?: {statusMessage?: string}}).data?.statusMessage ?? 'Your password could not be changed. Please try again.'
  } finally { saving.value = false }
}
useHead({title: 'Account · Product Imagery'})
</script>
<template>
  <div class="workspace-page account-page">
    <div class="workspace-page-heading"><div><span class="workspace-eyebrow">Your workspace identity</span><h1>Password & account</h1><p>{{ session.account.value?.displayName }} · {{ session.account.value?.username }} · {{ session.account.value?.organizationName }}</p></div></div>
    <AccountBalanceSummary :balance="accountBalance.balance.value" :pending="accountBalance.pending.value" :error="accountBalance.error.value" @refresh="accountBalance.refresh" />
    <AccountPaymentHistory class="account-payment-history" @balance="accountBalance.refresh()" />
    <form class="workspace-panel" @submit.prevent="changePassword"><h2>Change your password</h2><p>Choose a password with at least 10 characters. You will sign in again on every device after changing it.</p><div class="account-fields"><label class="workspace-field">Current password<input v-model="form.currentPassword" type="password" autocomplete="current-password" required maxlength="1024" /></label><label class="workspace-field">New password<input v-model="form.newPassword" type="password" autocomplete="new-password" required minlength="10" maxlength="256" /></label><label class="workspace-field">Confirm new password<input v-model="form.confirmation" type="password" autocomplete="new-password" required minlength="10" maxlength="256" /></label></div><div v-if="errorMessage" role="alert" class="workspace-inline-error">{{ errorMessage }}</div><div class="workspace-form-actions"><button class="workspace-button" type="submit" :disabled="saving">{{ saving ? 'Changing password…' : 'Change password' }}</button></div></form>
  </div>
</template>
<style scoped>.account-page{max-width:850px}.account-fields{display:grid;gap:18px;margin-top:28px;max-width:430px}.account-page>form,.account-payment-history{margin-top:28px}</style>
