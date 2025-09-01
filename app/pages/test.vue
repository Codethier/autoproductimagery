<script setup lang="ts">

let p =  await useFetch('/api/test', {})

let cookie = useCookie('test')

cookie.value = 'test'
</script>

<template>
<div>
{{p.data}}
  <UButton @click="p.refresh()">asd</UButton>
</div>
</template>

<style scoped>

</style>