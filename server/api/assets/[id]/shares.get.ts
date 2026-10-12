export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    assertMethod(event, 'GET')
    return {shares: await (await useUserFS(actor)).sharesFor(getRouterParam(event, 'id') ?? '')}
})
