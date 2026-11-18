<script setup lang="ts">
import type {AccountBalance} from '~~/schemas/account-billing'
import {formatBalanceUsd, formatUsd} from '../utils/generationPrice'
const props = defineProps<{balance: AccountBalance | null; pending?: boolean; error?: string; title?: string}>()
defineEmits<{refresh: []}>()
const {t} = useI18n()
const heading = computed(() => props.title || t('account.balance.title'))
</script>

<template>
  <section class="account-balance-summary" :aria-label="heading">
    <div class="account-balance-heading"><h2>{{ heading }}</h2><button type="button" :disabled="pending" @click="$emit('refresh')"><UIcon :name="pending ? 'i-lucide-loader-circle' : 'i-lucide-refresh-cw'" />{{ pending ? t('account.balance.updating') : t('common.actions.refresh') }}</button></div>
    <div v-if="balance" class="account-balance-values">
      <div><span>{{ t('account.balance.actual') }}</span><strong>{{ balance.unlimited ? t('common.layout.unlimited') : formatBalanceUsd(balance.actualBalanceUsd) }}</strong><small>{{ t('account.balance.availableCredit') }}</small></div>
      <div><span>{{ t('account.balance.outstanding') }}</span><strong>{{ formatUsd(balance.outstandingEstimateUsd) }}<span v-if="balance.outstandingUnknownCount">{{ t('common.layout.unpricedSuffix') }}</span></strong><small>{{ t(balance.outstandingCount === 1 ? 'account.balance.awaitingOne' : 'account.balance.awaitingOther', {count: balance.outstandingCount}) }}<span v-if="balance.outstandingUnknownCount"> · {{ t('account.balance.withoutEstimate', {count: balance.outstandingUnknownCount}) }}</span></small></div>
      <div><span>{{ t('account.balance.confirmedSpend') }}</span><strong>{{ formatUsd(balance.confirmedSpendUsd) }}</strong><small>{{ t('account.balance.confirmedSpendHelp') }}</small></div>
      <div><span>{{ t('account.balance.totalPaid') }}</span><strong>{{ formatUsd(balance.totalPaidUsd) }}</strong><small>{{ t('account.balance.totalPaidHelp') }}</small></div>
      <div><span>{{ t('account.balance.unpaid') }}</span><strong>{{ formatUsd(balance.unpaidUsd) }}</strong><small>{{ t('account.balance.unpaidHelp') }}</small></div>
      <div v-if="balance.overpaidUsd && balance.overpaidUsd !== '0.000000000000'"><span>{{ t('account.balance.paidAhead') }}</span><strong>{{ formatUsd(balance.overpaidUsd) }}</strong><small>{{ t('account.balance.paidAheadHelp') }}</small></div>
    </div>
    <p v-else role="status">{{ pending ? t('account.balance.loading') : t('account.balance.unavailable') }}</p>
    <p v-if="error" role="alert" class="account-balance-error">{{ error }}</p>
    <p class="account-balance-note">{{ t('account.balance.note') }}</p>
  </section>
</template>

<style scoped>
.account-balance-summary{padding:22px;border:1px solid var(--workspace-border);border-radius:14px;background:var(--workspace-surface)}.account-balance-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.account-balance-heading h2{font-size:15px;font-weight:550}.account-balance-heading button{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--workspace-muted)}.account-balance-heading button:disabled{opacity:.5}.account-balance-heading .iconify{width:13px;height:13px}.account-balance-values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.account-balance-values>div>span{display:block;font-size:11px;color:var(--workspace-muted);margin-bottom:9px}.account-balance-values strong{display:block;font-size:21px;font-weight:500;color:#edcba5;overflow-wrap:anywhere}.account-balance-values strong>span{font-size:11px;font-weight:400}.account-balance-values small{display:block;font-size:10px;line-height:1.7;color:var(--workspace-muted);margin-top:7px}.account-balance-note{font-size:10px;line-height:1.7;color:var(--workspace-muted);margin-top:22px;max-width:670px}.account-balance-error{font-size:11px;color:#e4a698;margin-top:14px}@media(max-width:650px){.account-balance-values{grid-template-columns:minmax(0,1fr);gap:22px}.account-balance-values>div{padding-bottom:18px;border-bottom:1px solid var(--workspace-border)}.account-balance-values strong{font-size:20px}}
</style>
