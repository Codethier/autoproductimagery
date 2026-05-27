<script setup lang="ts">
import type {BreadcrumbItem} from "#ui/components/Breadcrumb.vue";
import {useDataStore} from "~/stores/data.store";
import type {SelectableFile} from "~~/schemas/main.dto";
import type {FormSubmitEvent} from "#ui/types";

const props = defineProps<{
  isModelSelect?: boolean
  isImageSelect?: boolean
}>()

const route = useRoute()
const router = useRouter()
let dataStore = useDataStore()
const toast = useToast()

let images: Ref<File[]> = ref([])
const uploading = ref(false)
const creatingFolder = ref(false)


function normalizeQueryPath(v: unknown): string {
  if (v == null) return '/'
  const s = String(v)
  if (!s || s === 'undefined' || s === 'null') return '/'
  return s
}

let path = ref(normalizeQueryPath(router.currentRoute.value.query.path))
watch(path, () => router.push({query: {path: path.value}}))
watch(() => route.query.path, (v) => {
  const next = normalizeQueryPath(v)
  if (next !== path.value) {
    path.value = next
  }
})

let folders = computed(() => {
  if (!path.value) return []
  const parts = path.value.split('/')
  return ['/', ...parts.filter(p => p)];
})
let bradCrumbItems = computed(() => {
  let l: BreadcrumbItem[] = []
  let currentPath = ''

  folders.value.forEach((folder) => {
    if (folder === '/') {
      l.push({label: 'Home', to: {query: {path: '/'}}})
      currentPath = '/'
    } else {
      currentPath += folder + '/'
      l.push({label: folder, to: {query: {path: currentPath.slice(0, -1)}}})
    }
  })

  return l
})

async function enterFolder(folder: string) {
  if (path.value.endsWith('/')) {
    path.value = path.value.slice(0, -1)
  }
  path.value = path.value + '/' + folder
}

let items = await useFetch('/api/files', {
  deep: true, query: {path}, key: () => `files:${path.value}`, transform: (input) => {
    input!.files.forEach((file) => {
      file.selectedImage = dataStore.inputImages.includes(file.url)
      file.selectedModel = dataStore.models.includes(file.url)
    })
    return input
  }
})

function syncSelectToStore(file: SelectableFile) {
  // Sync selected images
  const imgIdx = dataStore.inputImages.indexOf(file.url)
  if (file.selectedImage) {
    if (imgIdx === -1) dataStore.inputImages.push(file.url)
  } else {
    if (imgIdx !== -1) dataStore.inputImages.splice(imgIdx, 1)
  }

  // Sync selected models
  const modelIdx = dataStore.models.indexOf(file.url)
  if (file.selectedModel) {
    if (modelIdx === -1) dataStore.models.push(file.url)
  } else {
    if (modelIdx !== -1) dataStore.models.splice(modelIdx, 1)
  }
}

function buildUploadBody(): FormData {
  const form = new FormData()
  for (const file of images.value) form.append('files', file)
  form.append('path', path.value)
  return form
}

async function fileFormSubmit() {
  if (images.value.length === 0 || uploading.value) return
  uploading.value = true
  try {
    const result = await $fetch<{ saved: string[]; failed: Array<{ filename: string; reason: string }> }>(
        '/api/upload',
        { method: 'POST', body: buildUploadBody() }
    )
    if (result.saved.length > 0) {
      toast.add({
        title: `Uploaded ${result.saved.length} file${result.saved.length === 1 ? '' : 's'}`,
        color: 'success'
      })
    }
    if (result.failed.length > 0) {
      toast.add({
        title: `Failed to upload ${result.failed.length} file${result.failed.length === 1 ? '' : 's'}`,
        description: result.failed.map((f) => `${f.filename}: ${f.reason}`).join('\n'),
        color: 'error'
      })
    }
    images.value = []
    await items.refresh()
  } catch (err: any) {
    toast.add({ title: 'Upload failed', description: err?.statusMessage ?? err?.message, color: 'error' })
  } finally {
    uploading.value = false
  }
}

let newFolderName = ref('')

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name || creatingFolder.value) return
  creatingFolder.value = true
  try {
    await $fetch('/api/createFolder', { method: 'POST', body: { path: path.value, name } })
    newFolderName.value = ''
    await items.refresh()
    toast.add({ title: `Folder "${name}" created`, color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Could not create folder',
      description: err?.statusMessage ?? err?.message,
      color: 'error'
    })
  } finally {
    creatingFolder.value = false
  }
}

async function deleteFileOrFolder(filename: string) {
  const confirmed = window.confirm(`Delete "${filename}"? This cannot be undone.`)
  if (!confirmed) return
  const base = path.value.endsWith('/') ? path.value.slice(0, -1) : path.value
  const pathToSubmit = `${base}/${filename}`
  try {
    await $fetch('/api/deleteFileOrFolder', { method: 'DELETE', body: { path: pathToSubmit } })
    await items.refresh()
    toast.add({ title: `Deleted "${filename}"`, color: 'success' })
  } catch (err: any) {
    toast.add({ title: 'Delete failed', description: err?.statusMessage ?? err?.message, color: 'error' })
  }
}

function clearModelSelection() {
  try {
    ;(dataStore.models as any).splice(0)
  } catch { /* no-op */ }
  const files = items.data.value?.files
  if (files) {
    for (const f of files) f.selectedModel = false
  }
}

function clearImageSelection() {
  try {
    ;(dataStore.inputImages as any).splice(0)
  } catch { /* no-op */ }
  const files = items.data.value?.files
  if (files) {
    for (const f of files) f.selectedImage = false
  }
}

async function handlePaste(event: ClipboardEvent) {
  const target = event.target as HTMLElement | null
  if (target) {
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
  }
  const clipboardItems = event.clipboardData?.items
  if (!clipboardItems) return

  const pastedFiles: File[] = []
  for (const item of clipboardItems) {
    if (item.kind !== 'file') continue
    if (!item.type.startsWith('image/')) continue
    const blob = item.getAsFile()
    if (!blob) continue
    const ext = item.type.split('/')[1] || 'png'
    const name = blob.name && blob.name !== 'image.png'
        ? blob.name
        : `pasted-${Date.now()}.${ext}`
    pastedFiles.push(new File([blob], name, {type: item.type}))
  }
  if (pastedFiles.length === 0) return

  event.preventDefault()
  images.value = [...images.value, ...pastedFiles]
}

onMounted(() => window.addEventListener('paste', handlePaste))
onBeforeUnmount(() => window.removeEventListener('paste', handlePaste))
</script>

<template>
  <div>

    <div
        class=" grid grid-cols-4 justify-items-center justify-center  gap-2 m-12 border-2 border-dashed border-gray-300 rounded-lg p-12">
      <UBreadcrumb :items="bradCrumbItems" class="col-span-4"/>
      <div class="col-span-4 flex flex-col gap-2">
        <UFileUpload v-model="images" label="Drop your image here" accept="image/*" multiple class="w-96 min-h-48"
                     description="WEBP, PNG, JPG" icon="i-lucide-image"/>
        <UButton :disabled="images.length === 0 || uploading" :loading="uploading"
                 @click="fileFormSubmit" type="submit" label="Upload"/>
        <UPopover>
          <UButton label="Create New Folder" color="neutral" variant="subtle"/>

          <template #content>
            <div class="inline-flex m-4 gap-2">
              <UInput v-model="newFolderName" placeholder="Folder Name" class="w-full"
                      @keydown.enter="createFolder()"/>
              <UButton @click="createFolder()" :disabled="!newFolderName.trim() || creatingFolder"
                       :loading="creatingFolder" label="Save"/>
            </div>
          </template>
        </UPopover>
        <div class="flex gap-2">
          <UButton v-if="props.isModelSelect" size="xs" variant="subtle" color="neutral" @click="clearModelSelection" :disabled="dataStore.models.length === 0">Clear model selection</UButton>
          <UButton v-if="props.isImageSelect" size="xs" variant="subtle" color="neutral" @click="clearImageSelection" :disabled="dataStore.inputImages.length === 0">Clear image selection</UButton>
        </div>

      </div>
      <div v-for="dir of items.data.value?.dirs"
           class="flex justify-center items-center gap-2 flex-col  cursor-pointer hover:text-primary-500 w-full h-full">
        <UIcon @click="enterFolder(dir.name)" name="material-symbols-create-new-folder" class="size-16"></UIcon>
        <p class="w-full truncate text-center">{{ dir.name }}</p>
        <UIcon name="i-heroicons-trash" class="size-6 text-red-500 cursor-pointer"
               @click="deleteFileOrFolder(dir.name)"></UIcon>
      </div>
      <div v-for="file of items.data.value?.files"
           class="text-center text-balance flex flex-col gap-2 justify-center items-center w-full h-full">
        <img :src="`api/data${file.url}`" class="w-full object-contain" loading="lazy">
        <p class="w-full truncate text-center">{{ file.name }}</p>
        <UCheckbox v-if="props.isModelSelect" v-model="file.selectedModel"
                   @change="syncSelectToStore(file)"></UCheckbox>
        <UCheckbox v-if="props.isImageSelect" v-model="file.selectedImage"
                   @change="syncSelectToStore(file)"></UCheckbox>
        <UIcon name="i-heroicons-trash" class="size-6 text-red-500 cursor-pointer"
               @click="deleteFileOrFolder(file.name)"></UIcon>
      </div>

    </div>
<!--    <div>-->
<!--      <div v-if="props.isModelSelect">-->
<!--        <h1>Models</h1>-->
<!--        <div v-for="model in dataStore.models"-->
<!--             class="flex justify-center items-center gap-2 flex-col  cursor-pointer hover:text-primary-500">-->
<!--          <img :src="model">-->
<!--        </div>-->
<!--      </div>-->
<!--      <div v-if="props.isImageSelect">-->
<!--        <h1>Input Images</h1>-->
<!--        <div v-for="inputImage in dataStore.inputImages"-->
<!--             class="flex justify-center items-center gap-2 flex-col  cursor-pointer hover:text-primary-500">-->
<!--          <img :src="inputImage">-->
<!--        </div>-->
<!--      </div>-->
<!--    </div>-->
  </div>
</template>

<style scoped>

</style>