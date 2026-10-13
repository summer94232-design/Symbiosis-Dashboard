import { memo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const elements = ['p','br','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','em','del','blockquote','hr','code','pre','a','table','thead','tbody','tr','th','td','input']
const plugins = [remarkGfm]
const safeLink = (value: string) => {
    try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : '' }
    catch { return '' }
}
const components: Components = {
    a: ({ href, children }) => safeLink(href || '')
        ? <a href={safeLink(href || '')} target="_blank" rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
    table: ({ children }) => <div className="ai-table-scroll" role="region" aria-label="AI 回答表格" tabIndex={0}><table>{children}</table></div>,
    input: ({ type, checked }) => type === 'checkbox' ? <input type="checkbox" checked={!!checked} disabled readOnly aria-label={checked ? '已完成' : '未完成'} /> : null,
}
const AiMarkdown = memo(function AiMarkdown({ text }: { text: string }) {
    return <div className="ai-markdown"><Markdown remarkPlugins={plugins} allowedElements={elements} skipHtml urlTransform={safeLink} components={components}>{text}</Markdown></div>
})
export default AiMarkdown
