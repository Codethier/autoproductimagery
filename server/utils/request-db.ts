import {drizzle} from 'drizzle-orm/libsql'

export async function useDrizzle() {
    return  drizzle('./sqlite.db')
}