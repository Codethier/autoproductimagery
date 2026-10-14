<script setup lang="ts">
import {formatBalanceUsd} from '../utils/generationPrice'
const credit = useGenerationCredit()
const account = useAccount()
const balance = useAccountBalance()
const panel = ref<HTMLElement>()
let previousFocus: HTMLElement | null = null
function validOutsideFocus(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && target !== document.body && target !== document.documentElement && !panel.value?.contains(target)
}
function rememberFocus(event: FocusEvent) {
  if (!credit.open.value && validOutsideFocus(event.target)) previousFocus = event.target
}
watch(credit.open, async value => {
  if (value) {
    // The submit button can lose focus while a fresh balance check temporarily
    // disables it. Keep its last focus origin when the browser falls to body.
    if (validOutsideFocus(document.activeElement)) previousFocus = document.activeElement
    await nextTick()
    if (credit.open.value) panel.value?.querySelector<HTMLButtonElement>('button')?.focus()
  } else if (previousFocus?.isConnected) previousFocus.focus()
})
function keydown(event: KeyboardEvent) {
  if (!credit.open.value) return
  event.stopPropagation()
  // Window capture runs before an underlying People/pipeline dialog's trap.
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); credit.close(); return }
  if (event.key !== 'Tab') return
  event.stopPropagation()
  const elements = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? [])]
  const first = elements[0], last = elements.at(-1)
  if (!first || !last) { event.preventDefault(); return }
  if (event.shiftKey && (document.activeElement === first || !panel.value?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || !panel.value?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
}
async function viewBalance() { credit.close(); await navigateTo('/account') }
async function manageBalances() { credit.close(); await navigateTo('/team') }
onMounted(() => {
  if (validOutsideFocus(document.activeElement)) previousFocus = document.activeElement
  window.addEventListener('focusin', rememberFocus)
  window.addEventListener('keydown', keydown, {capture: true})
})
onBeforeUnmount(() => { window.removeEventListener('focusin', rememberFocus); window.removeEventListener('keydown', keydown, {capture: true}); if (credit.open.value && previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <div v-if="credit.open.value" class="credit-dialog-backdrop" @click.self="credit.close()">
    <section ref="panel" class="credit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="generation-credit-title" aria-describedby="generation-credit-description">
      <header><span class="credit-dialog-symbol"><UIcon name="i-lucide-wallet" /></span><button type="button" class="credit-dialog-close" aria-label="Close balance notice" @click="credit.close()"><UIcon name="i-lucide-x" /></button></header>
      <span class="credit-dialog-eyebrow">Generation credit</span>
      <h2 id="generation-credit-title">More balance needed</h2>
      <p id="generation-credit-description">Your available generation credit is used up. {{ account.isOwner.value ? 'Add credit from Team before starting another generation.' : 'Ask your organization owner to add credit before starting another generation.' }}</p>
      <div v-if="balance.balance.value && !balance.balance.value.unlimited" class="credit-dialog-balance"><span>Available credit</span><strong>{{ formatBalanceUsd(balance.balance.value.actualBalanceUsd) }}</strong></div>
      <footer><button type="button" class="credit-dialog-secondary" @click="credit.close()">Close</button><button type="button" class="credit-dialog-secondary" @click="viewBalance">View balance</button><button v-if="account.isOwner.value" type="button" class="credit-dialog-primary" @click="manageBalances">Manage balances</button></footer>
    </section>
  </div>
</template>

<style scoped>
.credit-dialog-backdrop{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:24px;background:#0b090bd9;backdrop-filter:blur(7px)}.credit-dialog{width:min(460px,100%);max-height:calc(100dvh - 48px);overflow:auto;padding:28px;border:1px solid var(--workspace-border);border-radius:18px;background:var(--workspace-surface);color:var(--workspace-text);box-shadow:0 24px 90px #0009}.credit-dialog header{display:flex;justify-content:space-between;align-items:center;margin-bottom:23px}.credit-dialog-symbol{display:grid;place-items:center;width:42px;height:42px;background:var(--workspace-surface-raised);border:1px solid var(--workspace-border);border-radius:12px;color:var(--workspace-accent)}.credit-dialog-symbol .iconify{width:20px;height:20px}.credit-dialog-close{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;color:var(--workspace-muted)}.credit-dialog-close:hover{background:var(--workspace-surface-raised)}.credit-dialog-close .iconify{width:16px;height:16px}.credit-dialog-eyebrow{font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:var(--workspace-accent)}.credit-dialog h2{margin-top:9px;font-size:25px;letter-spacing:-.7px;font-weight:550}.credit-dialog p{margin-top:14px;font-size:12px;line-height:1.8;color:var(--workspace-muted)}.credit-dialog-balance{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:22px;padding:14px;border:1px solid var(--workspace-border);border-radius:10px;background:var(--workspace-bg)}.credit-dialog-balance span{font-size:11px;color:var(--workspace-muted)}.credit-dialog-balance strong{font-size:15px;font-weight:550;color:var(--workspace-accent);font-variant-numeric:tabular-nums}.credit-dialog footer{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:9px;margin-top:26px}.credit-dialog-secondary,.credit-dialog-primary{padding:10px 12px;font-size:11px;border-radius:8px;border:1px solid var(--workspace-border);background:var(--workspace-surface-raised);color:var(--workspace-text)}.credit-dialog-primary{border-color:transparent;background:var(--workspace-accent);color:#241c15;font-weight:550}.credit-dialog button{cursor:pointer}.credit-dialog button:focus-visible{outline:2px solid var(--workspace-accent);outline-offset:3px}@media(max-width:560px){.credit-dialog-backdrop{padding:12px}.credit-dialog{padding:23px;max-height:calc(100dvh - 24px)}}
</style>
