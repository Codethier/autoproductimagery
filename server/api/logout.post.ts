import { deleteCookie, getHeader, getRequestProtocol } from "h3"
import { AUTH_COOKIE_NAME } from "../utils/authSession"

export default defineEventHandler((event) => {
    const forwardedProtocol = getHeader(event, "x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
    const secure = process.env.NODE_ENV === "production"
        || forwardedProtocol === "https"
        || getRequestProtocol(event) === "https"
    deleteCookie(event, AUTH_COOKIE_NAME, {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/",
    })
    return true
})
