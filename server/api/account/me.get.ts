import {setHeader} from 'h3'
import {publicAccountProfile} from '../../utils/accountSession'

export default defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    return publicAccountProfile(await useAuth(event))
})
