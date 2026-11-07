export default defineEventHandler(async (event) => {
  // Validate the opaque signed session cookie without exposing its contents.
  await useAuth(event)

  // If authentication passed, return true so the client knows credentials are valid
  return true
})
