<script setup lang="ts">
import {CreateOrganizationUserSchema, UpdateOrganizationUserSchema, type OrganizationUser} from '~~/schemas/accounts'
import {SetAccountBalanceSchema, type AccountBalance} from '~~/schemas/account-billing'
import {serverOrKeyMessage, uiMessageText, type UiMessage} from '../utils/uiMessage'
definePageMeta({layout: 'workspace', colorMode: 'dark', middleware: 'owner'})
const session = useAccount()
const ownBalance = useAccountBalance()
const toast = useToast()
const {t} = useI18n()
const translate = (key: string, params?: Record<string, unknown>) => t(key, params ?? {})
const offset = ref(0)
const users = useFetch<{users: OrganizationUser[]; total: number}>('/api/org/users', {query: {limit: 50, offset}, key: `organization-users:${session.identity.value}`})
const editing = ref<OrganizationUser>()
const formOpen = ref(false)
const formElement = ref<HTMLElement>()
const saving = ref(false)
// Client messages keep their key; server explanations are shown as returned.
const formFailure = ref<UiMessage | null>(null)
const errorMessage = computed(() => uiMessageText(formFailure.value, translate))
const form = reactive({username: '', displayName: '', password: '', role: 'user' as 'owner' | 'user', disabled: false})
const balanceTarget = ref<OrganizationUser>()
const balanceDetails = ref<AccountBalance | null>(null)
const balanceForm = reactive({unlimited: true, actualBalanceUsd: '0.00'})
const balanceLoading = ref(false)
const balanceSaving = ref(false)
const balanceFailure = ref<UiMessage | null>(null)
const balanceError = computed(() => uiMessageText(balanceFailure.value, translate))
const paymentSaving = ref(false)
const balanceVersion = ref(0)
let balanceRequest = 0
function closeBalance() { if (paymentSaving.value) return; balanceRequest += 1; balanceTarget.value = undefined; balanceDetails.value = null; balanceLoading.value = false; balanceSaving.value = false; balanceFailure.value = null }
function acceptPaymentBalance(receipt: {userId: string; epoch: number; identity: string; version: number; balance: AccountBalance}) {
  if (!balanceDetails.value || receipt.userId !== balanceTarget.value?.id || receipt.epoch !== session.epoch.value || receipt.identity !== session.identity.value || receipt.version !== balanceVersion.value || balanceLoading.value || balanceSaving.value) return
  balanceDetails.value = receipt.balance
  if (balanceTarget.value?.id === session.account.value?.userId) void ownBalance.refresh()
}
async function openBalance(user: OrganizationUser) {
  if (paymentSaving.value && balanceTarget.value?.id !== user.id) return
  balanceVersion.value += 1
  balanceTarget.value = user; balanceDetails.value = null; balanceFailure.value = null; balanceLoading.value = true
  const epoch = session.epoch.value; const request = ++balanceRequest
  try {
    const response = await $fetch<{userId: string; balance: AccountBalance}>(`/api/org/users/${user.id}/balance`)
    if (epoch !== session.epoch.value || request !== balanceRequest || response.userId !== user.id) return
    balanceDetails.value = response.balance
    balanceForm.unlimited = response.balance.unlimited
    // Setting a balance accepts nonnegative amounts; an overdrawn balance is
    // still shown above without copying it into an invalid input.
    balanceForm.actualBalanceUsd = response.balance.actualBalanceUsd?.startsWith('-') ? '0.00' : response.balance.actualBalanceUsd ?? '0.00'
  } catch (error) { if (epoch === session.epoch.value && request === balanceRequest) balanceFailure.value = serverOrKeyMessage(error, 'account.team.balanceLoadFailed') }
  finally { if (epoch === session.epoch.value && request === balanceRequest) balanceLoading.value = false }
}
async function saveBalance() {
  if (!balanceTarget.value || balanceSaving.value || balanceLoading.value || paymentSaving.value) return
  const parsed = SetAccountBalanceSchema.safeParse({actualBalanceUsd: balanceForm.unlimited ? null : balanceForm.actualBalanceUsd})
  if (!parsed.success) { balanceFailure.value = {key: 'account.team.balanceInvalid'}; return }
  balanceVersion.value += 1
  const userId = balanceTarget.value.id; const epoch = session.epoch.value; const request = balanceRequest
  balanceSaving.value = true; balanceFailure.value = null
  try {
    const response = await $fetch<{userId: string; balance: AccountBalance}>(`/api/org/users/${userId}/balance`, {method: 'PATCH', body: parsed.data})
    if (epoch !== session.epoch.value || request !== balanceRequest || response.userId !== userId) return
    balanceDetails.value = response.balance
    toast.add({title: t('account.team.balanceUpdated'), color: 'success'})
    if (userId === session.account.value?.userId) await ownBalance.refresh()
  } catch (error) { if (epoch === session.epoch.value && request === balanceRequest) balanceFailure.value = serverOrKeyMessage(error, 'account.team.balanceUpdateFailed') }
  finally { if (epoch === session.epoch.value && request === balanceRequest) balanceSaving.value = false }
}
watch(session.epoch, () => {paymentSaving.value = false; closeBalance()}, {flush: 'sync'})
function openForm(user?: OrganizationUser) {
  editing.value = user
  Object.assign(form, {username: user?.username ?? '', displayName: user?.displayName ?? '', password: '', role: user?.role ?? 'user', disabled: user?.disabled ?? false})
  formFailure.value = null
  formOpen.value = true
  void nextTick(() => { formElement.value?.scrollIntoView({block: 'nearest'}); formElement.value?.querySelector<HTMLInputElement>('input')?.focus() })
}
function closeForm() { form.password = ''; formOpen.value = false; editing.value = undefined }
const invalidFieldKeys: Record<string, string> = {username: 'account.team.invalidUsername', displayName: 'account.team.invalidDisplayName', password: 'account.team.invalidPassword'}
async function save() {
  if (saving.value) return
  formFailure.value = null
  const body = editing.value ? {displayName: form.displayName, role: form.role, disabled: form.disabled, ...(form.password ? {password: form.password} : {})}
    : {username: form.username, displayName: form.displayName, role: form.role, password: form.password}
  const parsed = editing.value ? UpdateOrganizationUserSchema.safeParse(body) : CreateOrganizationUserSchema.safeParse(body)
  if (!parsed.success) { formFailure.value = {key: invalidFieldKeys[String(parsed.error.issues[0]?.path[0] ?? '')] ?? 'account.team.invalidDetails'}; return }
  saving.value = true
  const editingSelf = editing.value?.id === session.account.value?.userId
  const wasEditing = Boolean(editing.value)
  const epoch = session.epoch.value
  try {
    await $fetch(editing.value ? `/api/org/users/${editing.value.id}` : '/api/org/users', {method: editing.value ? 'PATCH' : 'POST', body: parsed.data})
    if (epoch !== session.epoch.value) return
    closeForm()
    await users.refresh()
    if (epoch !== session.epoch.value) return
    toast.add({title: t(wasEditing ? 'account.team.accountUpdated' : 'account.team.accountSaved'), color: 'success'})
    if (editingSelf) { await session.load(); session.notifyTabs(); if (!session.isOwner.value) await navigateTo('/assets') }
  } catch (error) { if (epoch === session.epoch.value) formFailure.value = serverOrKeyMessage(error, 'account.team.saveFailed') }
  finally { saving.value = false }
}
useHead({title: computed(() => t('account.team.pageTitle'))})
onBeforeUnmount(() => { form.password = '' })
</script>

<template>
  <div class="workspace-page">
    <div class="workspace-page-heading"><div><span class="workspace-eyebrow">{{ session.account.value?.organizationName }}</span><h1>{{ t('account.team.title') }}</h1><p>{{ t('account.team.intro') }}</p></div><button class="workspace-button" type="button" @click="openForm()"><UIcon name="i-lucide-user-round-plus" />{{ t('account.team.addUser') }}</button></div>
    <section class="workspace-panel team-panel" :aria-label="t('account.team.usersLabel')">
      <p v-if="users.status.value === 'pending'" role="status">{{ t('account.team.loading') }}</p>
      <div v-else-if="users.error.value" class="workspace-inline-error" role="alert">{{ t('account.team.loadFailed') }} <button type="button" @click="users.refresh()">{{ t('common.actions.retry') }}</button></div>
      <div v-else class="team-table-wrap"><table class="team-table"><thead><tr><th scope="col">{{ t('account.team.columns.person') }}</th><th scope="col">{{ t('account.team.columns.role') }}</th><th scope="col">{{ t('account.team.columns.access') }}</th><th scope="col"><span class="sr-only">{{ t('account.team.columns.actions') }}</span></th></tr></thead><tbody><tr v-for="user in users.data.value?.users" :key="user.id"><td><strong>{{ user.displayName }}<span v-if="user.id === session.account.value?.userId" class="team-you">{{ t('account.team.you') }}</span></strong><span>{{ user.username }}</span></td><td>{{ user.role === 'owner' ? t('common.layout.organizationOwner') : t('common.layout.member') }}</td><td><span class="team-status" :class="{'team-status--disabled': user.disabled}">{{ user.disabled ? t('account.team.disabled') : t('account.team.active') }}</span></td><td><button class="workspace-button secondary team-balance-button" type="button" :aria-label="t('account.team.balanceButtonLabel', {name: user.displayName})" @click="openBalance(user)">{{ t('account.team.balanceButton') }}</button><button class="workspace-button secondary" type="button" :aria-label="t('account.team.manageLabel', {name: user.displayName})" @click="openForm(user)">{{ t('account.team.manage') }}</button></td></tr></tbody></table></div>
      <div v-if="(users.data.value?.total ?? 0) > 50" class="team-pagination"><button class="workspace-button secondary" :disabled="!offset" @click="offset = Math.max(0, offset - 50)">{{ t('account.team.previous') }}</button><span>{{ t('account.team.pagination', {start: offset + 1, end: Math.min(offset + 50, users.data.value?.total ?? 0), total: users.data.value?.total ?? 0}) }}</span><button class="workspace-button secondary" :disabled="offset + 50 >= (users.data.value?.total ?? 0)" @click="offset += 50">{{ t('common.actions.next') }}</button></div>
    </section>
    <section v-if="balanceTarget" class="workspace-panel team-balance-panel" :aria-label="t('account.team.balancePanelLabel', {name: balanceTarget.displayName})">
      <div class="team-form-heading"><h2>{{ t('account.team.balanceHeading', {name: balanceTarget.displayName}) }}</h2><button type="button" class="workspace-icon-button" :aria-label="t('account.team.closeBalance')" :disabled="balanceSaving || paymentSaving" @click="closeBalance"><UIcon name="i-lucide-x" /></button></div>
      <AccountBalanceSummary :title="t('account.team.balanceTitle', {name: balanceTarget.displayName})" :balance="balanceDetails" :pending="balanceLoading" @refresh="openBalance(balanceTarget!)" />
      <form v-if="balanceDetails" class="team-balance-form" @submit.prevent="saveBalance"><label class="team-disable"><input v-model="balanceForm.unlimited" type="checkbox" :disabled="balanceSaving || paymentSaving" />{{ t('account.team.unlimitedCredit') }}</label><label v-if="!balanceForm.unlimited" class="workspace-field">{{ t('account.team.setBalance') }}<input v-model="balanceForm.actualBalanceUsd" inputmode="decimal" type="text" required maxlength="25" :disabled="balanceSaving || paymentSaving" /></label><p>{{ t('account.team.balanceHelp') }}</p><div class="workspace-form-actions"><button class="workspace-button" type="submit" :disabled="balanceSaving || balanceLoading || paymentSaving">{{ balanceSaving ? t('common.actions.saving') : t('account.team.saveBalance') }}</button></div></form>
      <p v-if="balanceError" class="workspace-inline-error" role="alert">{{ balanceError }}</p>
      <AccountPaymentHistory :key="balanceTarget.id" :user-id="balanceTarget.id" :owner-controls="true" :balance="balanceDetails" :balance-pending="balanceLoading || balanceSaving" :balance-version="balanceVersion" @balance="acceptPaymentBalance" @busy="paymentSaving = $event" />
    </section>
    <form v-if="formOpen" ref="formElement" class="workspace-panel team-form" @submit.prevent="save"><div class="team-form-heading"><h2>{{ editing ? t('account.team.manageTitle', {name: editing.displayName}) : t('account.team.addTitle') }}</h2><button type="button" class="workspace-icon-button" :aria-label="t('account.team.closeForm')" :disabled="saving" @click="closeForm"><UIcon name="i-lucide-x" /></button></div><p>{{ editing ? t('account.team.editHelp') : t('account.team.createHelp') }}</p><div class="workspace-form-grid"><label class="workspace-field">{{ t('account.team.displayName') }}<input v-model="form.displayName" required maxlength="80" autocomplete="off" /></label><label class="workspace-field">{{ t('account.team.username') }}<input v-model="form.username" :disabled="Boolean(editing)" required maxlength="64" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9._@+\-]*" /></label><label class="workspace-field">{{ editing ? t('account.team.resetPassword') : t('account.team.initialPassword') }}<input v-model="form.password" type="password" :required="!editing" minlength="10" maxlength="256" autocomplete="new-password" :placeholder="t('account.team.passwordPlaceholder')" /></label><label class="workspace-field">{{ t('account.team.role') }}<select v-model="form.role"><option value="user">{{ t('common.layout.member') }}</option><option value="owner">{{ t('common.layout.organizationOwner') }}</option></select></label></div><p class="team-role-help">{{ t('account.team.roleHelp') }}</p><label v-if="editing" class="team-disable"><input v-model="form.disabled" type="checkbox" />{{ t('account.team.disableAccount') }}</label><div v-if="errorMessage" class="workspace-inline-error" role="alert">{{ errorMessage }}</div><div class="workspace-form-actions"><button type="button" class="workspace-button secondary" :disabled="saving" @click="closeForm">{{ t('common.actions.cancel') }}</button><button type="submit" class="workspace-button" :disabled="saving">{{ saving ? t('common.actions.saving') : editing ? t('account.team.saveChanges') : t('account.team.createAccount') }}</button></div></form>
  </div>
</template>

<style scoped>
.team-table th{position:relative}
.team-balance-panel{margin-top:28px}.team-balance-panel>.account-balance-summary,.team-balance-panel>.account-payments{margin-top:22px}.team-balance-form>.workspace-field{max-width:350px;margin-top:22px}.team-balance-form>p{font-size:11px;margin-top:12px}.team-balance-button{margin-right:9px}
.team-panel{padding:0;overflow:hidden}.team-table-wrap{overflow-x:auto}.team-table{width:100%;border-collapse:collapse;text-align:left;font-size:12px;min-width:580px}.team-table th{font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--workspace-muted);padding:16px 22px;border-bottom:1px solid var(--workspace-border)}.team-table td{padding:20px 22px;border-bottom:1px solid #3a373080}.team-table td:first-child>strong,.team-table td:first-child>span{display:block}.team-table td:first-child>strong{font-weight:550}.team-table td:first-child>span{font-size:11px;color:var(--workspace-muted);margin-top:5px}.team-table td:last-child{text-align:right}.team-you{font-size:9px;font-weight:400;margin-left:10px;color:var(--workspace-muted)}.team-status{display:inline-flex;border-radius:999px;background:#394338;color:#c1d3b0;font-size:10px;padding:5px 9px}.team-status--disabled{background:#44332e;color:#dfb8aa}.team-form{margin-top:28px}.team-form-heading{display:flex;justify-content:space-between;align-items:center}.team-form .workspace-form-grid{margin-top:25px}.team-disable{display:flex;gap:9px;align-items:center;font-size:12px;margin-top:18px}.team-role-help{font-size:11px!important}.team-pagination{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;font-size:11px;color:var(--workspace-muted)}
</style>
