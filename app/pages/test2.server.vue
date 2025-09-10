<script setup lang="ts">

let prisma = usePrisma()
  // await prisma.test.create({
  //   data: {
  //     name: 'test'
  //   }
  // })
let tests = await prisma.test.findMany()

async function addTest() {
  await prisma.test.create({
    data: {
      name: 'test'
    }
  })
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