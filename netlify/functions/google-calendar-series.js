import { handler } from '../lib/google-calendar-series.js'
import { invokeEventHandler } from '../lib/http-function.js'

export default async function (request) {
    return invokeEventHandler(request, handler)
}
