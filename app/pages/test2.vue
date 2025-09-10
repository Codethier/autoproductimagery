<script setup lang="ts">


let tests = await useFetch('/api/test', {})

async function addTest() {
  await $fetch('/api/test', {method: 'post',})
  await tests.refresh()
}


</script>

<template>
<div>

  {{tests}}
    <UButton nuxt-client @click="addTest">asd</UButton>
</div>
</template>

<style scoped>

</style>