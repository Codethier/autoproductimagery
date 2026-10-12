<script setup lang="ts">
import {CreateOrganizationUserSchema, UpdateOrganizationUserSchema, type OrganizationUser} from '~~/schemas/accounts'
definePageMeta({layout: 'workspace', colorMode: 'dark', middleware: 'owner'})
const session = useAccount()
const toast = useToast()
const offset = ref(0)
const users = useFetch<{users: OrganizationUser[]; total: number}>('/api/org/users', {query: {limit: 50, offset}, key: `organization-users:${session.identity.value}`})
const editing = ref<OrganizationUser>()
const formOpen = ref(false)
const formElement = ref<HTMLElement>()
const saving = ref(false)
const errorMessage = ref('')
const form = reactive({username: '', displayName: '', password: '', role: 'user' as 'owner' | 'user', disabled: false})
function openForm(user?: OrganizationUser) {
  editing.value = user
  Object.assign(form, {username: user?.username ?? '', displayName: user?.displayName ?? '', password: '', role: user?.role ?? 'user', disabled: user?.disabled ?? false})
  errorMessage.value = ''
  formOpen.value = true
  void nextTick(() => { formElement.value?.scrollIntoView({block: 'nearest'}); formElement.value?.querySelector<HTMLInputElement>('input')?.focus() })
}
function closeForm() { form.password = ''; formOpen.value = false; editing.value = undefined }
async function save() {
  if (saving.value) return
  errorMessage.value = ''
  const body = editing.value ? {displayName: form.displayName, role: form.role, disabled: form.disabled, ...(form.password ? {password: form.password} : {})}
    : {username: form.username, displayName: form.displayName, role: form.role, password: form.password}
  const parsed = editing.value ? UpdateOrganizationUserSchema.safeParse(body) : CreateOrganizationUserSchema.safeParse(body)
  if (!parsed.success) { errorMessage.value = parsed.error.issues[0]?.message ?? 'Check the account details.'; return }
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
    toast.add({title: wasEditing ? 'Account updated' : 'Account saved', color: 'success'})
    if (editingSelf) { await session.load(); session.notifyTabs(); if (!session.isOwner.value) await navigateTo('/assets') }
  } catch (error) { if (epoch === session.epoch.value) errorMessage.value = (error as {data?: {statusMessage?: string}}).data?.statusMessage ?? 'The account could not be saved. Please try again.' }
  finally { saving.value = false }
}
useHead({title: 'Team · Product Imagery'})
onBeforeUnmount(() => { form.password = '' })
</script>

<template>
  <div class="workspace-page">
    <div class="workspace-page-heading"><div><span class="workspace-eyebrow">{{ session.account.value?.organizationName }}</span><h1>The people in your studio</h1><p>Create accounts for your team. Everyone has a personal image library and can share selected files or folders with others in your organization.</p></div><button class="workspace-button" type="button" @click="openForm()"><UIcon name="i-lucide-user-round-plus" />Add user</button></div>
    <section class="workspace-panel team-panel" aria-label="Organization users">
      <p v-if="users.status.value === 'pending'" role="status">Loading your team…</p>
      <div v-else-if="users.error.value" class="workspace-inline-error" role="alert">Could not load the team. <button type="button" @click="users.refresh()">Try again</button></div>
      <div v-else class="team-table-wrap"><table class="team-table"><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Access</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody><tr v-for="user in users.data.value?.users" :key="user.id"><td><strong>{{ user.displayName }}<span v-if="user.id === session.account.value?.userId" class="team-you">You</span></strong><span>{{ user.username }}</span></td><td>{{ user.role === 'owner' ? 'Organization owner' : 'Member' }}</td><td><span class="team-status" :class="{'team-status--disabled': user.disabled}">{{ user.disabled ? 'Disabled' : 'Active' }}</span></td><td><button class="workspace-button secondary" type="button" :aria-label="`Manage ${user.displayName}`" @click="openForm(user)">Manage</button></td></tr></tbody></table></div>
      <div v-if="(users.data.value?.total ?? 0) > 50" class="team-pagination"><button class="workspace-button secondary" :disabled="!offset" @click="offset = Math.max(0, offset - 50)">Previous</button><span>{{ offset + 1 }}–{{ Math.min(offset + 50, users.data.value?.total ?? 0) }} of {{ users.data.value?.total }}</span><button class="workspace-button secondary" :disabled="offset + 50 >= (users.data.value?.total ?? 0)" @click="offset += 50">Next</button></div>
    </section>
    <form v-if="formOpen" ref="formElement" class="workspace-panel team-form" @submit.prevent="save"><div class="team-form-heading"><h2>{{ editing ? `Manage ${editing.displayName}` : 'Add a person' }}</h2><button type="button" class="workspace-icon-button" aria-label="Close account form" :disabled="saving" @click="closeForm"><UIcon name="i-lucide-x" /></button></div><p>{{ editing ? 'Disabling an account revokes its sessions. Resetting a password signs the user out on all devices.' : 'Give the person their username and password privately. They can change their password after signing in.' }}</p><div class="workspace-form-grid"><label class="workspace-field">Display name<input v-model="form.displayName" required maxlength="80" autocomplete="off" /></label><label class="workspace-field">Username<input v-model="form.username" :disabled="Boolean(editing)" required maxlength="64" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9._@+\-]*" /></label><label class="workspace-field">{{ editing ? 'Reset password (optional)' : 'Initial password' }}<input v-model="form.password" type="password" :required="!editing" minlength="10" maxlength="256" autocomplete="new-password" placeholder="At least 10 characters" /></label><label class="workspace-field">Role<select v-model="form.role"><option value="user">Member</option><option value="owner">Organization owner</option></select></label></div><p class="team-role-help">Organization owners can create and manage accounts. A role does not give access to another person’s private files.</p><label v-if="editing" class="team-disable"><input v-model="form.disabled" type="checkbox" />Disable this account</label><div v-if="errorMessage" class="workspace-inline-error" role="alert">{{ errorMessage }}</div><div class="workspace-form-actions"><button type="button" class="workspace-button secondary" :disabled="saving" @click="closeForm">Cancel</button><button type="submit" class="workspace-button" :disabled="saving">{{ saving ? 'Saving…' : editing ? 'Save changes' : 'Create account' }}</button></div></form>
  </div>
</template>

<style scoped>
.team-panel{padding:0;overflow:hidden}.team-table-wrap{overflow-x:auto}.team-table{width:100%;border-collapse:collapse;text-align:left;font-size:12px;min-width:580px}.team-table th{font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--workspace-muted);padding:16px 22px;border-bottom:1px solid var(--workspace-border)}.team-table td{padding:20px 22px;border-bottom:1px solid #3a373080}.team-table td:first-child>strong,.team-table td:first-child>span{display:block}.team-table td:first-child>strong{font-weight:550}.team-table td:first-child>span{font-size:11px;color:var(--workspace-muted);margin-top:5px}.team-table td:last-child{text-align:right}.team-you{font-size:9px;font-weight:400;margin-left:10px;color:var(--workspace-muted)}.team-status{display:inline-flex;border-radius:999px;background:#394338;color:#c1d3b0;font-size:10px;padding:5px 9px}.team-status--disabled{background:#44332e;color:#dfb8aa}.team-form{margin-top:28px}.team-form-heading{display:flex;justify-content:space-between;align-items:center}.team-form .workspace-form-grid{margin-top:25px}.team-disable{display:flex;gap:9px;align-items:center;font-size:12px;margin-top:18px}.team-role-help{font-size:11px!important}.team-pagination{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;font-size:11px;color:var(--workspace-muted)}
</style>
