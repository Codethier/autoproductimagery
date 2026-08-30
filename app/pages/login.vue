<script setup lang="ts">
import { object, string } from 'yup'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const loading = ref(false)

const form = reactive({
  username: '',
  password: ''
})

const schema = object({
  username: string().required('Username is required'),
  password: string().required('Password is required')
})

async function onSubmit() {
  try {
    loading.value = true

    // The server verifies credentials and issues an opaque HttpOnly session cookie.
    const ok = await $fetch('/api/login', {
      method: 'POST',
      body: {
        username: form.username,
        password: form.password
      }
    })
    if (ok !== true) {
      throw new Error('Invalid credentials')
    }
    useState<boolean | undefined>('auth-session', () => undefined).value = true

    // Navigate to intended destination
    const requestedTarget = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    const target = requestedTarget.startsWith('/') && !requestedTarget.startsWith('//')
      ? requestedTarget
      : '/'
    await router.replace(target)
    toast.add({ title: 'Signed in', description: 'You have been signed in.' })
  } catch (e) {
    console.error(e)
    toast.add({ title: 'Sign in failed', color: 'warning' })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <UCard class="w-full max-w-md">
      <template #header>
        <div class="flex items-center justify-between">
          <h1 class="text-xl font-semibold">Sign in</h1>
        </div>
      </template>

      <UForm :state="form" :schema="schema" @submit="onSubmit" class="space-y-4">
        <UFormField label="Username" name="username" required>
          <UInput v-model="form.username" placeholder="Enter username" autofocus />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput v-model="form.password" type="password" placeholder="Enter password" />
        </UFormField>

        <UButton type="submit" color="primary" :loading="loading" block>Login</UButton>
      </UForm>

      <template #footer>
        <div class="text-xs text-gray-500">
          You will be redirected to the requested page after login.
        </div>
      </template>
    </UCard>
  </div>
</template>



<style scoped>
</style>
