<script setup lang="ts">


let tests = await useFetch('/api/test', {})
let data = ref()
let path = ref('/')

async function addTest() {
  data.value = await $fetch('/api/test', {method: 'post',body:{path:path.value}})
  await tests.refresh()
}


</script>

<template>
<div>

  {{tests}}
  <UInput v-model="path" />
    <UButton nuxt-client @click="addTest">asd</UButton>
  {{data}}

  <files></files>
</div>
</template>

<style scoped>

</style>