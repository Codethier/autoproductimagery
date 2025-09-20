export default defineEventHandler(async (event) => {
  // Authenticate using the shared server utility. This reads authUser/authPassword
  // from runtime config and validates the 'auth' cookie value formatted as "user:pass".
  useAuth(event)

  // If authentication passed, return true so the client knows credentials are valid
  return true
})
