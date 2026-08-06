import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { ImagePlus, LoaderCircle, Redo2, Undo2 } from 'lucide-react'
import { prepareAndUploadNoteImage, type NoteImageAsset } from '../../lib/kmsImages'
import './richText.css'

interface Props {
  noteId: string
  value?: JSONContent
  fallbackText: string
  assets: NoteImageAsset[]
  preserveAssetIds?: string[]
  onChange: (doc: JSONContent, plainText: string, assets: NoteImageAsset[]) => void
  onAssetUploaded: (asset: NoteImageAsset) => void
  onUploadingChange?: (uploading: boolean) => void
}

const AssetImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: { default: null },
      storagePath: { default: null },
      width: { default: null },
    }
  },
}).configure({
  inline: false,
  allowBase64: false,
  resize: {
    enabled: true,
    directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    minWidth: 120,
    minHeight: 80,
    alwaysPreserveAspectRatio: true,
  },
})

function textToRichDoc(text: string): JSONContent {
  const lines = text.split('\n')
  return {
    type: 'doc',
    content: lines.map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : undefined,
    })),
  }
}

function collectAssetIds(doc: JSONContent): Set<string> {
  const ids = new Set<string>()
  const visit = (node: JSONContent) => {
    if (node.type === 'image' && typeof node.attrs?.assetId === 'string') ids.add(node.attrs.assetId)
    node.content?.forEach(visit)
  }
  visit(doc)
  return ids
}

function ToolbarButton({
  active = false,
  disabled = false,
  title,
  children,
  onClick,
}: {
  active?: boolean
  disabled?: boolean
  title: string
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`rich-editor-tool${active ? ' active' : ''}`}
      disabled={disabled}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export default function RichTextEditor({ noteId, value, fallbackText, assets, preserveAssetIds = [], onChange, onAssetUploaded, onUploadingChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const assetsRef = useRef(assets)
  const preserveAssetIdsRef = useRef(preserveAssetIds)
  const uploadingRef = useRef(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState('')

  useEffect(() => {
    assetsRef.current = assets
  }, [assets])

  useEffect(() => {
    preserveAssetIdsRef.current = preserveAssetIds
  }, [preserveAssetIds])

  const emitChange = (editor: Editor, candidateAssets = assetsRef.current) => {
    const doc = editor.getJSON()
    const referencedIds = collectAssetIds(doc)
    preserveAssetIdsRef.current.forEach(id => referencedIds.add(id))
    const referencedAssets = candidateAssets.filter(asset => referencedIds.has(asset.id))
    assetsRef.current = referencedAssets
    onChange(doc, editor.getText({ blockSeparator: '\n' }), referencedAssets)
  }

  const uploadFiles = async (files: File[], insertionPosition?: number) => {
    const editor = editorRef.current
    if (!editor || uploadingRef.current || files.length === 0) return
    const imageFiles = files.filter(file => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name))
    if (!imageFiles.length) return
    if (assetsRef.current.length + imageFiles.length > 30) {
      setUploadError('每則筆記最多可插入 30 張圖片')
      return
    }

    setUploading(true)
    uploadingRef.current = true
    onUploadingChange?.(true)
    setUploadError('')
    try {
      if (typeof insertionPosition === 'number') {
        editor.commands.setTextSelection(Math.min(insertionPosition, editor.state.doc.content.size))
      }
      for (let index = 0; index < imageFiles.length; index += 1) {
        const file = imageFiles[index]
        const asset = await prepareAndUploadNoteImage(file, noteId, progress => {
          setUploadProgress((index + progress) / imageFiles.length)
        })
        const nextAssets = [...assetsRef.current, asset]
        assetsRef.current = nextAssets
        onAssetUploaded(asset)
        editor.chain().focus().insertContent({
          type: 'image',
          attrs: {
            src: asset.downloadUrl,
            alt: file.name.replace(/\.[^.]+$/, ''),
            title: file.name,
            assetId: asset.id,
            storagePath: asset.storagePath,
            width: asset.width,
          },
        }).createParagraphNear().run()
        emitChange(editor, nextAssets)
      }
    } catch (error) {
      console.error(error)
      setUploadError(error instanceof Error ? error.message : '圖片處理或上傳失敗')
    } finally {
      setUploading(false)
      uploadingRef.current = false
      onUploadingChange?.(false)
      setUploadProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      AssetImage,
      Placeholder.configure({ placeholder: '輸入內容；可拖曳、貼上或插入圖片…' }),
    ],
    content: value ?? textToRichDoc(fallbackText),
    editorProps: {
      attributes: {
        class: 'rich-editor-content',
        spellcheck: 'true',
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (!files.some(file => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name))) return false
        event.preventDefault()
        void uploadFiles(files)
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (!files.some(file => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name))) return false
        event.preventDefault()
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void uploadFiles(files, position)
        return true
      },
    },
    onCreate: ({ editor: createdEditor }) => {
      editorRef.current = createdEditor
    },
    onUpdate: ({ editor: updatedEditor }) => emitChange(updatedEditor),
  })

  useEffect(() => {
    editorRef.current = editor
    return () => {
      editorRef.current = null
    }
  }, [editor])

  useEffect(() => {
    if (!editor || value || editor.getText({ blockSeparator: '\n' }) === fallbackText) return
    editor.commands.setContent(textToRichDoc(fallbackText), { emitUpdate: false })
  }, [editor, fallbackText, value])

  if (!editor) return <div className="rich-editor-shell">載入編輯器中…</div>

  return (
    <div className="rich-editor-shell">
      <div className="rich-editor-toolbar" role="toolbar" aria-label="文章格式">
        <ToolbarButton title="粗體" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></ToolbarButton>
        <ToolbarButton title="斜體" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></ToolbarButton>
        <ToolbarButton title="標題" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</ToolbarButton>
        <ToolbarButton title="項目清單" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>• 列表</ToolbarButton>
        <ToolbarButton title="編號清單" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. 列表</ToolbarButton>
        <ToolbarButton title="引用" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>❝</ToolbarButton>
        <span className="rich-editor-divider" />
        <ToolbarButton title="插入圖片" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? <LoaderCircle size={15} className="rich-editor-spinner" /> : <ImagePlus size={15} />}
        </ToolbarButton>
        <ToolbarButton title="復原" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={15} /></ToolbarButton>
        <ToolbarButton title="重做" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={15} /></ToolbarButton>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          hidden
          onChange={event => void uploadFiles(Array.from(event.target.files ?? []))}
        />
      </div>
      {uploading && (
        <div className="rich-editor-progress" aria-live="polite">
          <span style={{ width: `${Math.max(3, uploadProgress * 100)}%` }} />
          <small>正在轉檔、壓縮並上傳 {Math.round(uploadProgress * 100)}%</small>
        </div>
      )}
      {uploadError && <div className="rich-editor-error" role="alert">{uploadError}</div>}
      <EditorContent editor={editor} />
      <div className="rich-editor-hint">圖片會先壓縮再上傳；可拖曳圖片、貼上截圖，或使用工具列插入。</div>
    </div>
  )
}
