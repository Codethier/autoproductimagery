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

let images: Ref<File[]> = ref([])


let currentQuery = router.currentRoute.value.query.path
let path = ref('')
if (currentQuery) {
  path.value = String(currentQuery)
} else {
  path.value = '/'
}
watch(path, () => router.push({query: {path: path.value}}))
watch(() => route.query.path, (v) => {
  if (v !== path.value) {
    path.value = String(v)
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

let formSubmitBody = computed(() => {
  let form: FormData = new FormData()
  for (const file of images.value) {
    form.append('files', file)
  }
  form.append('path', path.value)
  return form
})

async function fileFormSubmit() {
  let sumBytes = 0
  for (const file of images.value) {
    sumBytes += file.size
  }
  let response = await useFetch('/api/upload', {method: 'POST', body: formSubmitBody})
  if (response.error.value) {
    console.error(response.error.value)
  }
  console.log(response.data.value)
  await items.refresh()
}

let newFolderName = ref('')

async function createFolder() {
  console.log('call')
  let response = await useFetch('/api/createFolder', {
    method: 'POST',
    body: {path: path.value, name: newFolderName.value}
  })
  await items.refresh()
  newFolderName.value = ''
  return true
}

async function deleteFileOrFolder(filename: string) {
  let pathToSubmit = String(path.value)
  pathToSubmit = pathToSubmit + '/' + filename
  let response = await useFetch('/api/deleteFileOrFolder', {
    method: 'DELETE',
    body: {path: pathToSubmit},
    key: `/deleteFile${pathToSubmit}`
  })
  await items.refresh()
  return true
}
</script>

<template>
  <div>

    <div
        class=" grid grid-cols-4 justify-items-center justify-center  gap-2 m-12 border-2 border-dashed border-gray-300 rounded-lg p-12">
      <UBreadcrumb :items="bradCrumbItems" class="col-span-4"/>
      <div class="col-span-4 flex flex-col gap-2">
        <UFileUpload v-model="images" label="Drop your image here" accept="image/*" multiple class="w-96 min-h-48"
                     description="WEBP, PNG, JPG" icon="i-lucide-image"/>
        <UButton :disabled="images.length === 0" @click="fileFormSubmit" type="submit" label="Upload"/>
        <UPopover>
          <UButton label="Create New Folder" color="neutral" variant="subtle"/>

          <template #content>
            <div class="inline-flex m-4 gap-2">
              <UInput v-model="newFolderName" placeholder="Folder Name" class="w-full"/>
              <UButton @click="createFolder()" label="Save"/>
            </div>
          </template>
        </UPopover>

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
        <img :src="file.url" class="w-full object-contain">
        <p class="w-full truncate text-center">{{ file.name }}</p>
        <UCheckbox v-if="props.isModelSelect" v-model="file.selectedModel"
                   @change="syncSelectToStore(file)"></UCheckbox>
        <UCheckbox v-if="props.isImageSelect" v-model="file.selectedImage"
                   @change="syncSelectToStore(file)"></UCheckbox>
        <UIcon name="i-heroicons-trash" class="size-6 text-red-500 cursor-pointer"
               @click="deleteFileOrFolder(file.name)"></UIcon>
      </div>

    </div>
    <div>
      <div v-if="props.isModelSelect">
        <h1>Models</h1>
        <div v-for="model in dataStore.models"
             class="flex justify-center items-center gap-2 flex-col  cursor-pointer hover:text-primary-500">
          <img :src="model">
        </div>
      </div>
      <div v-if="props.isImageSelect">
        <h1>Input Images</h1>
        <div v-for="inputImage in dataStore.inputImages"
             class="flex justify-center items-center gap-2 flex-col  cursor-pointer hover:text-primary-500">
          <img :src="inputImage">
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>

</style>