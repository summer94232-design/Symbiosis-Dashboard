import { Fragment, type ReactNode } from 'react'
import type { JSONContent } from '@tiptap/react'
import type { NoteImageAsset } from '../../lib/kmsImages'
import './richText.css'

interface Props {
  doc: JSONContent
  assets?: NoteImageAsset[]
}

function renderText(node: JSONContent, key: string): ReactNode {
  let content: ReactNode = node.text ?? ''
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') content = <strong>{content}</strong>
    else if (mark.type === 'italic') content = <em>{content}</em>
    else if (mark.type === 'strike') content = <s>{content}</s>
    else if (mark.type === 'code') content = <code>{content}</code>
    else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
      content = <a href={mark.attrs.href} target="_blank" rel="noopener noreferrer">{content}</a>
    }
  }
  return <Fragment key={key}>{content}</Fragment>
}

function renderNode(node: JSONContent, assets: NoteImageAsset[], key: string): ReactNode {
  if (node.type === 'text') return renderText(node, key)
  if (node.type === 'hardBreak') return <br key={key} />

  const children = node.content?.map((child, index) => renderNode(child, assets, `${key}-${index}`))
  switch (node.type) {
    case 'doc': return <Fragment key={key}>{children}</Fragment>
    case 'paragraph': return <p key={key}>{children}</p>
    case 'heading': {
      const level = Math.min(3, Math.max(2, Number(node.attrs?.level) || 2))
      return level === 3 ? <h3 key={key}>{children}</h3> : <h2 key={key}>{children}</h2>
    }
    case 'bulletList': return <ul key={key}>{children}</ul>
    case 'orderedList': return <ol key={key}>{children}</ol>
    case 'listItem': return <li key={key}>{children}</li>
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>
    case 'codeBlock': return <pre key={key}><code>{children}</code></pre>
    case 'horizontalRule': return <hr key={key} />
    case 'image': {
      const asset = assets.find(item => item.id === node.attrs?.assetId)
      const src = asset?.downloadUrl || (typeof node.attrs?.src === 'string' ? node.attrs.src : '')
      if (!src) return null
      const storedWidth = Number.parseFloat(String(node.attrs?.width || ''))
      const width = asset && Number.isFinite(storedWidth) && asset.width > 0
        ? Math.min(100, Math.max(20, storedWidth / asset.width * 100))
        : 100
      return (
        <figure key={key} style={{ width: `${width}%` }}>
          <img
            src={src}
            alt={typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''}
            title={typeof node.attrs?.title === 'string' ? node.attrs.title : undefined}
            loading="lazy"
            decoding="async"
          />
          {typeof node.attrs?.caption === 'string' && node.attrs.caption && <figcaption>{node.attrs.caption}</figcaption>}
        </figure>
      )
    }
    default: return <Fragment key={key}>{children}</Fragment>
  }
}

export default function RichTextContent({ doc, assets = [] }: Props) {
  return <div className="rich-note-content">{renderNode(doc, assets, 'root')}</div>
}
