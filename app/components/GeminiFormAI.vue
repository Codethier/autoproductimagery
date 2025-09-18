<template>
  <UCard class="max-w-2xl mx-auto my-6">
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Gemini Prompt</h2>
        <UBadge v-if="model"  variant="subtle">{{ model }}</UBadge>
      </div>
    </template>

    <form @submit.prevent="onSubmit" class="space-y-4">
      <div>
        <UTextarea v-model="form.prompt" :rows="4" placeholder="Describe what you want Gemini to generate..." />
      </div>

      <div>
        <input type="file" accept="image/*" multiple @change="onFilesChange" />
        <div v-if="previews.length" class="mt-3 grid grid-cols-3 gap-2">
          <div v-for="(p, idx) in previews" :key="idx" class="border rounded p-1 flex flex-col items-center">
            <img :src="p.url" class="max-h-24 object-contain" />
            <div class="text-[10px] text-gray-600 mt-1 truncate w-full text-center">{{ p.name }} ({{ formatKB(p.size) }} KB)</div>
            <UButton  variant="soft"  class="mt-1" @click="removeImage(idx)">Remove</UButton>
          </div>
        </div>
      </div>

      <div class="flex gap-2 items-end">
          <UInput v-model="form.model" placeholder="models/gemini-2.0-flash-exp" />
        <UButton type="submit" :loading="loading" :disabled="!form.prompt?.trim()" icon="i-heroicons-rocket-launch">
          Generate
        </UButton>
      </div>
    </form>

    <div class="mt-6 space-y-3 min-h-20">
      <div v-if="error" class="text-red-600 text-sm">{{ error }}</div>

      <div v-if="result && (result.images?.length || 0) > 0" class="space-y-2">
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div v-for="(img, i) in result.images" :key="i" class="flex flex-col items-start gap-2">
            <img :src="`data:${img.mimeType};base64,${img.data}`" alt="Gemini image" class="rounded border max-w-full" />
            <UButton variant="soft" size="xs" @click="downloadImage(i)">Download</UButton>
          </div>
        </div>
      </div>

      <div v-if="result?.text && !loading">
        <pre class="whitespace-pre-wrap text-sm bg-gray-50 p-3 rounded border">{{ result.text }}</pre>
      </div>

      <div v-else-if="loading" class="text-gray-500 text-sm">Generating...</div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
const props = defineProps<{ defaultPrompt?: string; defaultModel?: string }>()

const form = reactive({
  prompt: props.defaultPrompt ?? '',
  model: props.defaultModel ?? ''
})

const model = computed(() => form.model || useRuntimeConfig().public.GeminiModels.gemini25FlashIOImagePreview)
const loading = ref(false)
const error = ref<string | null>(null)
const result = ref<{ text: string; images: Array<{ mimeType: string; data: string }> } | null>(null)
const errors = reactive<{ prompt?: string; images?: string }>({})

const previews = reactive<Array<{ url: string; name: string; size: number; mimeType: string; base64: string }>>([])

function formatKB(n: number) { return Math.round(n / 10.24) / 100 }

async function onFilesChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  // Reset and re-add with constraints
  previews.splice(0, previews.length)
  const maxFiles = 6
  const maxSize = 5 * 1024 * 1024 // 5MB per image
  let count = 0
  for (const f of files) {
    if (count >= maxFiles) break
    if (!f.type.startsWith('image/')) continue
    if (f.size > maxSize) {
      errors.images = `Image ${f.name} is too large (> 5MB)`
      continue
    }
    const base64 = await fileToBase64Raw(f)
    previews.push({ url: URL.createObjectURL(f), name: f.name, size: f.size, mimeType: f.type, base64 })
    count++
  }
}

function removeImage(idx: number) {
  const p = previews[idx]
  if (p) URL.revokeObjectURL(p.url)
  previews.splice(idx, 1)
}

function fileToBase64Raw(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      const res = String(reader.result || '')
      // remove data URL prefix if present
      const comma = res.indexOf(',')
      resolve(comma !== -1 ? res.slice(comma + 1) : res)
    }
    reader.readAsDataURL(file)
  })
}

async function onSubmit() {
  errors.prompt = !form.prompt?.trim() ? 'Please enter a prompt' : undefined
  if (errors.prompt) return

  loading.value = true
  error.value = null
  result.value = null
  try {
    const images = previews.map(p => ({ mimeType: p.mimeType, data: p.base64 }))
    const { data, error: e } = await useFetch('/api/gemini-batch', {
      method: 'POST',
      body: { prompt: form.prompt, model: form.model || undefined, images }
    })
    if (e.value) throw e.value
    result.value = data.value as any
  } catch (err: any) {
    error.value = err?.statusMessage || err?.message || 'Unknown error'
  } finally {
    loading.value = false
  }
}

function downloadImage(index: number) {
  if (!result.value) return
  const img = result.value.images?.[index]
  if (!img) return
  const link = document.createElement('a')
  link.href = `data:${img.mimeType};base64,${img.data}`
  link.download = `gemini-image-${index + 1}`
  link.click()
}
</script>
