<script setup lang="ts">
import type {BreadcrumbItem} from "#ui/components/Breadcrumb.vue";
import {useDataStore} from "~/stores/data.store";
import type {SelectableFile} from "~~/schemas/main.dto";
import type {FormSubmitEvent} from "#ui/types";

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

async function formSubmit() {
  let sumBytes = 0
  for (const file of images.value) {
    sumBytes += file.size
  }
  let response = await useFetch('/api/files', {method: 'POST', body: formSubmitBody})
  if (response.error.value) {
    console.error(response.error.value)
  }
  console.log(response.data.value)
}

</script>

<template>
  <div>
    <div>
          <UFileUpload v-model="images" label="Drop your image here" accept="image/*" multiple class="w-96 min-h-48"
                       description="WEBP, PNG, JPG" icon="i-lucide-image"/>
        <UButton :disabled="images.length === 0" @click="formSubmit" type="submit" label="Submit"/>

    </div>
    <div
        class=" grid grid-cols-4 justify-items-center justify-center  gap-2 m-12 border-2 border-dashed border-gray-300 rounded-lg p-12">
      <UBreadcrumb :items="bradCrumbItems" class="col-span-4"/>
      <div v-for="dir of items.data.value?.dirs"
           class="flex justify-center items-center gap-2 flex-col  cursor-pointer hover:text-primary-500"
           @click="enterFolder(dir.name)">
        <UIcon name="material-symbols-create-new-folder" class="size-30"></UIcon>
        {{ dir.name }}
      </div>
      <div v-for="file of items.data.value?.files"
           class="text-center text-balance flex flex-col gap-2 justify-center items-center">
        <img :src="file.url">
        <p class="truncate">{{ file.name }}</p>
        <UCheckbox v-model="file.selectedModel" @change="syncSelectToStore(file)"></UCheckbox>
        <UCheckbox v-model="file.selectedImage" @change="syncSelectToStore(file)"></UCheckbox>
      </div>

    </div>
    <div>
      <h1>Models</h1>
      <div v-for="model in dataStore.models"
           class="flex justify-center items-center gap-2 flex-col  cursor-pointer hover:text-primary-500">
        <img :src="model">
      </div>
      <h1>Input Images</h1>
      <div v-for="inputImage in dataStore.inputImages"
           class="flex justify-center items-center gap-2 flex-col  cursor-pointer hover:text-primary-500">
        <img :src="inputImage">
      </div>
    </div>
  </div>
</template>

<style scoped>

</style>