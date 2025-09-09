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

    // Set the cookie expected by server-side useAuth: "auth" = "user:pass"
    const auth = useCookie<string>('auth', { path: '/', sameSite: 'lax' })
    auth.value = `${form.username}:${form.password}`

    // test credentials
    let req = await useFetch('/api/testCredentials', {})
    if (!req.data) {
      throw new Error('Invalid credentials')
    }

    // Navigate to intended destination
    const target = (route.query.redirect as string) || '/'
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
