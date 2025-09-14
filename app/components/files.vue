<script setup lang="ts">
import type {BreadcrumbItem} from "#ui/components/Breadcrumb.vue";

const route = useRoute()
const router = useRouter()

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

let items = await useFetch('/api/files', {deep: true, query: {path}, key: () => `files:${path.value}`})


</script>

<template>
  <div>
    <div class=" grid grid-cols-9 justify-items-center justify-center  gap-2 m-12 border-2 border-dashed border-gray-300 rounded-lg p-12">
      <UBreadcrumb :items="bradCrumbItems" class="col-span-9"/>
      <div v-for="dir of items.data.value?.dirs"
           class="flex items-center gap-2 flex-col  cursor-pointer hover:text-primary-500"
           @click="enterFolder(dir.name)">
        <UIcon name="material-symbols-create-new-folder" class="size-30"></UIcon>
        {{ dir.name }}
      </div>
      <div v-for="file of items.data.value?.files" class="cursor-pointer flex items-center gap-2 flex-col">
        <img :src="`${file.parentPath.replace('./public','')}/${file.name}`">
        <p>{{ file.name }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>

</style>