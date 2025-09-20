<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  src: string
  alt?: string
  filename?: string
  downloadOnClick?: boolean
  showHoverIcon?: boolean
}>(), {
  alt: '',
  filename: undefined,
  downloadOnClick: true,
  showHoverIcon: true
})

const emit = defineEmits<{
  (e: 'download', filename: string): void
}>()

// Normalize image URL to our data API if it's a repo-stored path (e.g., "/images/.../")
const actualSrc = computed(() => {
  const s = props.src || ''
  if (!s || s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/api/')) {
    return s
  }
  // Ensure leading slash
  const withLead = s.startsWith('/') ? s : '/' + s
  // Prefix with our file-serving endpoint
  return '/api/data' + withLead
})

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.href : undefined)
    const last = u.pathname.split('/').filter(Boolean).pop() || 'image'
    return props.filename || decodeURIComponent(last)
  } catch {
    // If it's a data URL or invalid, fallback
    return props.filename || 'image'
  }
}

async function downloadImage(ev?: Event) {
  if (!props.downloadOnClick) return
  // Prevent parent click handlers from interfering
  if (ev) ev.stopPropagation()

  const name = filenameFromUrl(props.src)

  try {
    // If same-origin or data URL, we can try direct download first
    if (props.src.startsWith('data:')) {
      triggerDownload(props.src, name)
      emit('download', name)
      return
    }

    const urlObj = new URL(actualSrc.value, window.location.href)
    const sameOrigin = urlObj.origin === window.location.origin

    if (sameOrigin) {
      triggerDownload(actualSrc.value, name)
      emit('download', name)
      return
    }

    // Cross-origin: fetch to blob to avoid CORS download issues
    const res = await fetch(actualSrc.value, { mode: 'cors' })
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    try {
      triggerDownload(objectUrl, name)
      emit('download', name)
    } finally {
      // Revoke shortly after to allow the download to start
      setTimeout(() => URL.revokeObjectURL(objectUrl), 3000)
    }
  } catch (e) {
    // As a last resort, attempt direct download which may or may not work depending on CORS
    triggerDownload(actualSrc.value, name)
    emit('download', name)
  }
}

function triggerDownload(href: string, name: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  a.target = '_self'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function onKeydown(e: KeyboardEvent) {
  if (!props.downloadOnClick) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    downloadImage()
  }
}
</script>

<template>
  <span
    class="relative inline-block group select-none"
    :aria-label="alt || 'image'"
    :title="alt"
    role="button"
    tabindex="0"
    @click="downloadImage"
    @keydown="onKeydown"
  >
    <!-- Actual image behaves like a normal <img> via $attrs forwarding -->
    <img loading="lazy" :src="actualSrc" :alt="alt" v-bind="$attrs" />

    <!-- Hover overlay with transparent black gradient and download icon -->
    <span v-if="showHoverIcon"
          class="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-200">
      <!-- Gradient background covering the image -->
      <span class="absolute inset-0 bg-gradient-to-t from-black/60 via-black/30 to-transparent rounded-inherit"></span>
      <!-- Centered download icon -->
      <span class="absolute inset-0 flex items-center justify-center">
        <UIcon name="i-heroicons-arrow-down-tray" class="size-8 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"/>
      </span>
    </span>
  </span>
</template>

<style scoped>
/* No additional styles required; relying on utility classes. */
</style>
