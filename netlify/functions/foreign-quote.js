import { handler } from '../lib/foreign-quote.js'
import { invokeEventHandler } from '../lib/http-function.js'

export default async function (request) {
    return invokeEventHandler(request, handler)
}
