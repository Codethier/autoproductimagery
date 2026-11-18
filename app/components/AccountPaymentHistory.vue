<script setup lang="ts">
import type {AccountBalance} from '~~/schemas/account-billing'
import {formatUsd} from '../utils/generationPrice'
const props = withDefaults(defineProps<{userId?: string; ownerControls?: boolean; balance?: AccountBalance | null; balancePending?: boolean; balanceVersion?: number}>(), {ownerControls: false, balancePending: false, balanceVersion: 0})
const session = useAccount()
const {t, locale} = useI18n()
const emit = defineEmits<{balance: [receipt: {userId: string; epoch: number; identity: string; version: number; balance: AccountBalance}]; busy: [busy: boolean]}>()
const payments = useAccountPayments(toRef(props, 'userId'), toRef(props, 'ownerControls'), toRef(props, 'balance'), toRef(props, 'balancePending'), toRef(props, 'balanceVersion'))
watch(payments.balance, value => {const userId = props.userId ?? session.account.value?.userId; if (value && userId) emit('balance', {userId, epoch: session.epoch.value, identity: session.identity.value, version: payments.balanceReadVersion.value, balance: value})})
watch(payments.saving, value => emit('busy', value), {flush: 'sync'})
watch(() => [props.userId, props.ownerControls], () => {void payments.load()}, {flush: 'post'})
onServerPrefetch(() => payments.load())
onMounted(() => {if (!payments.loaded.value) void payments.load()})
function paymentDate(value: string) {
  const date = new Date(value)
  // Receipts are recorded in UTC; only the date wording follows the language.
  return Number.isNaN(date.getTime()) ? t('account.payments.dateUnavailable') : date.toLocaleString(locale.value === 'en' ? 'en-US' : locale.value, {dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'}) + ' UTC'
}
</script>

<template>
  <section class="account-payments" :aria-label="t('account.payments.title')">
    <div class="payment-heading"><div><h2>{{ t('account.payments.title') }}</h2><p>{{ t('account.payments.subtitle') }}</p></div><button class="workspace-button secondary" type="button" :disabled="payments.loading.value || payments.saving.value" @click="payments.load()"><UIcon name="i-lucide-refresh-cw" />{{ t('account.payments.refresh') }}</button></div>
    <form v-if="payments.canRecord.value || (ownerControls && payments.uncertain.value)" class="payment-form" @submit.prevent="payments.record()">
      <h3>{{ t('account.payments.recordTitle') }}</h3>
      <p>{{ t('account.payments.recordHelp') }}</p>
      <div class="payment-fields"><label class="workspace-field">{{ t('account.payments.amount') }}<input v-model="payments.amountUsd.value" type="text" inputmode="decimal" autocomplete="off" maxlength="10" placeholder="5.00" required :disabled="payments.saving.value || payments.uncertain.value" /></label><label class="workspace-field">{{ t('account.payments.note') }}<textarea v-model="payments.note.value" rows="2" maxlength="500" :placeholder="t('account.payments.notePlaceholder')" :disabled="payments.saving.value || payments.uncertain.value" /></label></div>
      <div class="workspace-form-actions"><button class="workspace-button" type="submit" :disabled="payments.saving.value">{{ payments.saving.value ? t('account.payments.recording') : payments.uncertain.value ? t('account.payments.retrySame') : t('account.payments.record') }}</button></div>
    </form>
    <p v-else-if="ownerControls && balance && !balance.unlimited" class="payment-info">{{ t('account.payments.finiteInfo') }}</p>
    <p v-if="payments.recordError.value" class="workspace-inline-error" role="alert">{{ payments.recordError.value }}</p>
    <p v-if="payments.notice.value" class="payment-notice" role="status">{{ payments.notice.value }}</p>
    <p v-if="payments.error.value" class="workspace-inline-error" role="alert">{{ payments.error.value }} <button type="button" @click="payments.load(Boolean(payments.nextCursor.value))">{{ t('common.actions.retry') }}</button></p>
    <p v-if="!payments.loaded.value && payments.loading.value" class="payment-info" role="status">{{ t('account.payments.loading') }}</p>
    <p v-else-if="payments.loaded.value && !payments.events.value.length" class="payment-empty">{{ t('account.payments.empty') }}<span>{{ ownerControls ? t('account.payments.emptyOwner') : t('account.payments.emptyMember') }}</span></p>
    <ol v-if="payments.events.value.length" class="payment-list">
      <li v-for="event in payments.events.value" :key="event.id"><div class="payment-receipt"><strong>{{ formatUsd(event.amountUsd) }}</strong><time :datetime="event.createdAt">{{ paymentDate(event.createdAt) }}</time></div><div class="payment-detail"><span>{{ t('account.payments.recordedBy', {name: event.recordedBy.displayName}) }} <span class="payment-username">({{ event.recordedBy.username }})</span></span><p v-if="event.note">{{ event.note }}</p></div></li>
    </ol>
    <div v-if="payments.nextCursor.value" class="payment-more"><button class="workspace-button secondary" type="button" :disabled="payments.loading.value || payments.saving.value" @click="payments.load(true)">{{ payments.loading.value ? t('common.states.loading') : t('account.payments.loadMore') }}</button></div>
    <p class="payment-footnote">{{ t('account.payments.footnote') }}</p>
  </section>
</template>

<style scoped>
.account-payments{padding:22px;border:1px solid var(--workspace-border);border-radius:14px;background:var(--workspace-surface)}.payment-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.payment-heading h2{font-size:15px;font-weight:550}.payment-heading p,.payment-form>p,.payment-info,.payment-footnote{font-size:11px;line-height:1.7;color:var(--workspace-muted)}.payment-heading p{margin-top:7px}.payment-heading button{flex-shrink:0;font-size:11px}.payment-form{margin-top:24px;padding:20px;border:1px solid var(--workspace-border);border-radius:11px;background:var(--workspace-bg)}.payment-form h3{font-size:13px;font-weight:550}.payment-form>p{margin-top:8px;max-width:650px}.payment-fields{display:grid;grid-template-columns:minmax(150px,210px) minmax(0,1fr);gap:18px;margin-top:20px}.payment-fields textarea{resize:vertical;min-height:70px}.payment-list{list-style:none;margin-top:24px;padding:0}.payment-list li{display:grid;grid-template-columns:minmax(150px,200px) minmax(0,1fr);gap:22px;padding:18px 0;border-bottom:1px solid var(--workspace-border)}.payment-list li:first-child{border-top:1px solid var(--workspace-border)}.payment-receipt strong{display:block;font-size:17px;font-weight:500;color:#edcba5}.payment-receipt time{display:block;font-size:10px;line-height:1.7;color:var(--workspace-muted);margin-top:7px}.payment-detail{font-size:11px;line-height:1.7;overflow-wrap:anywhere}.payment-username{color:var(--workspace-muted)}.payment-detail p{margin-top:7px;white-space:pre-wrap;color:var(--workspace-text)}.payment-empty{font-size:12px;margin-top:26px}.payment-empty span{display:block;font-size:11px;line-height:1.7;color:var(--workspace-muted);margin-top:7px}.payment-more{margin-top:20px}.payment-info,.payment-notice{margin-top:20px}.payment-notice{font-size:12px;color:#c1d3b0}.payment-footnote{margin-top:22px}.workspace-inline-error{margin-top:16px}.workspace-inline-error button{text-decoration:underline}.payment-footnote{font-size:10px}@media(max-width:650px){.account-payments{padding:18px}.payment-heading{flex-direction:column;gap:12px}.payment-fields,.payment-list li{grid-template-columns:minmax(0,1fr);gap:12px}.payment-form{padding:16px}.payment-heading button{align-self:flex-start}.payment-list li{padding:18px 0}}
</style>
