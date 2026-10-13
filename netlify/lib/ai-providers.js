import { AI_MODELS, MAX_OUTPUT } from './ai-policy.js'

const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : '' } catch { return '' } }
function citationsFrom(blocks) {
    const result = []
    for (const block of blocks) for (const item of [...(block.annotations || []), ...(block.citations || [])]) {
        const url = safeUrl(item.url || item.uri)
        if (url) result.push({ url, title: item.title || url, quote: item.cited_text || '' })
    }
    return [...new Map(result.map(item => [item.url, item])).values()].slice(0, 30)
}
export function providerRequest(model, system, messages, web, env = process.env, options = {}) {
    const spec = AI_MODELS[model]
    if (!spec || !env[spec.key] || env[spec.paid] !== 'true') throw new Error('此模型尚未完成後端金鑰與資料使用方案設定')
    if (spec.provider === 'gemini') return {
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env[spec.key] },
        body: { model, system_instruction: system, store: false, stream: false,
            input: messages.map(m => ({ type: m.role === 'user' ? 'user_input' : 'model_output', content: [{ type: 'text', text: m.content }] })),
            generation_config: { max_output_tokens: options.maxOutput ?? MAX_OUTPUT, thinking_level: options.thinkingLevel || 'low', thinking_summaries: 'none' },
            // Use the documented built-in tool form. Explicit search_types currently
            // returns an unexecuted google:search function_call for this account.
            ...(options.contextTool ? { tools: [{ type: 'function', ...options.contextTool }] } : web ? { tools: [{ type: 'google_search' }] } : {}) },
    }
    if (spec.provider === 'openai') return {
        url: 'https://api.openai.com/v1/responses',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env[spec.key]}` },
        body: { model, instructions: system, input: messages, store: false,
            reasoning: { effort: 'low' }, max_output_tokens: options.maxOutput ?? MAX_OUTPUT, max_tool_calls: 3,
            ...(options.contextTool ? { tools: [{ type: 'function', ...options.contextTool, strict: true }], parallel_tool_calls: false }
                : web ? { tools: [{ type: 'web_search', search_context_size: 'low' }] } : {}) },
    }
    return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env[spec.key], 'anthropic-version': '2023-06-01' },
        body: { model, system, messages, max_tokens: options.maxOutput ?? MAX_OUTPUT, thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
            ...(options.contextTool ? { tools: [{ name: options.contextTool.name, description: options.contextTool.description, input_schema: options.contextTool.parameters }] }
                : web ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] }] } : {}) },
    }
}
export function parseProvider(model, data) {
    const spec = AI_MODELS[model]
    if (spec.provider === 'gemini') {
        const steps = data.steps || data.outputs || []
        const modelOutputs = steps.filter(step => step.type === 'model_output')
        const blocks = modelOutputs.at(-1)?.content || steps.filter(step => step.type === 'text')
        const searches = steps.filter(step => step.type === 'google_search_call').reduce((sum, step) => sum + Math.max(1, step.queries?.length || step.arguments?.queries?.length || 0), 0)
        return { text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'), citations: citationsFrom(blocks),
            functionCalls: steps.filter(s => s.type === 'function_call').map(s => ({ name: s.name, arguments: s.arguments })),
            usage: { input: data.usage?.total_input_tokens, output: Number.isSafeInteger(data.usage?.total_output_tokens) && data.usage.total_output_tokens >= 0 && Number.isSafeInteger(data.usage?.total_thought_tokens) && data.usage.total_thought_tokens >= 0
                ? data.usage.total_output_tokens + data.usage.total_thought_tokens : NaN, thoughts: data.usage?.total_thought_tokens || 0,
                cached: data.usage?.total_cached_tokens ?? 0, searches },
            partial: data.status !== 'completed', searchSuggestions: steps.filter(s => s.type === 'google_search_result')
                .flatMap(s => [s.search_suggestions || '', ...(s.result || []).map(item => item.search_suggestions || '')]).filter(Boolean).join('') }
    }
    if (spec.provider === 'openai') {
        const blocks = (data.output || []).filter(o => o.type === 'message').flatMap(o => o.content || [])
        return { text: blocks.filter(b => b.type === 'output_text').map(b => b.text).join('\n'), citations: citationsFrom(blocks),
            functionCalls: (data.output || []).filter(s => s.type === 'function_call').map(s => ({ name: s.name, arguments: s.arguments })),
            usage: { input: data.usage?.input_tokens, output: data.usage?.output_tokens,
                searches: (data.output || []).filter(o => o.type === 'web_search_call').length }, partial: data.status !== 'completed' }
    }
    const blocks = data.content || []
    return { text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'), citations: citationsFrom(blocks),
        functionCalls: blocks.filter(s => s.type === 'tool_use').map(s => ({ name: s.name, arguments: s.input })),
        usage: { input: Number.isFinite(data.usage?.input_tokens) ? data.usage.input_tokens + (data.usage.cache_creation_input_tokens || 0) + (data.usage.cache_read_input_tokens || 0) : NaN,
            output: data.usage?.output_tokens, searches: data.usage?.server_tool_use?.web_search_requests || 0 },
        partial: data.stop_reason !== 'end_turn' }
}
export function tokenCountRequest(model, system, messages, env = process.env, options = {}) {
    if (AI_MODELS[model]?.provider !== 'gemini') throw new Error('此模型尚未支援費用上限所需的輸入計數')
    const source = providerRequest(model, system, messages, false, env, options)
    const generateContentRequest = { model: `models/${model}`,
        contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
        systemInstruction: { parts: [{ text: system }] },
        ...(options.contextTool ? { tools: [{ functionDeclarations: [{ name: options.contextTool.name,
            description: options.contextTool.description, parametersJsonSchema: options.contextTool.parameters }] }] } : {}),
    }
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`,
        headers: source.headers, body: { generateContentRequest } }
}
export async function countProviderTokens(model, system, messages, fetcher = fetch, env = process.env, options = {}) {
    const request = tokenCountRequest(model, system, messages, env, options)
    const response = await fetcher(request.url, { method: 'POST', headers: request.headers,
        body: JSON.stringify(request.body), signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error('AI 輸入用量無法確認，未新增模型生成，請手動重試')
    const count = (await response.json()).totalTokens
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) throw new Error('AI 輸入用量無法確認，未新增模型生成，請手動重試')
    return count
}
export async function callProvider(model, system, messages, web, fetcher = fetch, env = process.env, timeoutMs = 45000, options = {}) {
    const request = providerRequest(model, system, messages, web, env, options)
    // One HTTP attempt. Timeouts may still be billed; the caller keeps the reservation.
    const response = await fetcher(request.url, { method: 'POST', headers: request.headers,
        body: JSON.stringify(request.body), signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(response.status === 402 ? '模型付款設定或餘額尚未就緒，請先檢查供應商帳務' : response.status === 429 ? '模型用量受限，請稍後手動重試' : response.status === 404 ? '此帳戶目前無法使用選定模型' : '模型服務暫時無法使用，請手動重試')
    const data = await response.json()
    return parseProvider(model, data)
}
