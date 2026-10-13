/** Bridge existing event-based logic to Netlify's modern Request/Response runtime. */
export async function invokeEventHandler(request, handleEvent) {
    const url = new URL(request.url)
    const result = await handleEvent({
        httpMethod: request.method,
        headers: Object.fromEntries(request.headers),
        queryStringParameters: Object.fromEntries(url.searchParams),
        body: request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text(),
    })
    const status = result.statusCode
    const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status)
    return new Response(noBody ? null : result.body ?? '', { status, headers: result.headers })
}
