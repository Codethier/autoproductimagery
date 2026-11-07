export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    assertMethod(event, 'GET')
    return {users: await (await useUserFS(actor)).shareTargets()}
})
