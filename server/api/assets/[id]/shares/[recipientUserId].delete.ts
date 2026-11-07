export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    assertMethod(event, 'DELETE')
    await (await useUserFS(actor)).revoke(getRouterParam(event, 'id') ?? '', getRouterParam(event, 'recipientUserId') ?? '')
    return {ok: true}
})
