import type { JSONContent } from '@tiptap/react'
import { writeBatch } from 'firebase/firestore'
import { deleteObject, ref } from 'firebase/storage'
import { kmsDB, kmsStorage } from './firebase'
import {
  deleteNoteImageAssets,
  deleteStoragePath,
  finalizeNoteImageAssets,
  prepareAndUploadNoteImage,
  uploadPrivateNoteFile,
  type NoteImageAsset,
} from './kmsImages'
import { userDoc } from './userDB'
import { buildKmsSearchTerms, buildKmsTagPaths } from './kmsSearch'

export interface LegacyKmsNote {
  id?: string
  content?: string
  imageUrl?: string
  coverAssetId?: string
  fileUrl?: string
  fileName?: string
  fileStoragePath?: string
  contentDoc?: JSONContent
  assets?: NoteImageAsset[]
  title?: string
  hashtags?: string[]
}

export function needsLegacyNoteMigration(note: LegacyKmsNote): boolean {
  return Boolean(
    note.id &&
    ((note.imageUrl && !note.coverAssetId) ||
      (note.fileUrl && !note.fileStoragePath) ||
      note.content || note.contentDoc || (note.assets?.length ?? 0) > 0),
  )
}

async function downloadAsFile(url: string, fileName: string, fallbackType = 'application/octet-stream'): Promise<File> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下載舊附件失敗（HTTP ${response.status}）`)
  const blob = await response.blob()
  return new File([blob], fileName, { type: blob.type || fallbackType })
}

async function tryDeleteLegacyUrl(url?: string): Promise<void> {
  if (!url) return
  try {
    await deleteObject(ref(kmsStorage, url))
  } catch (error) {
    // 舊路徑鎖為唯讀後無法由前端刪除；資料已切換到私有路徑，不影響使用。
    console.warn('舊附件已遷移，但舊 Storage 物件需由管理端清理', error)
  }
}

export async function migrateLegacyKmsNote(
  note: LegacyKmsNote,
  onProgress: (progress: number) => void = () => undefined,
): Promise<void> {
  if (!note.id) throw new Error('筆記缺少識別碼')
  if (!needsLegacyNoteMigration(note)) return

  const migrateImage = Boolean(note.imageUrl && !note.coverAssetId)
  const migrateFile = Boolean(note.fileUrl && !note.fileStoragePath)

  let newImage: NoteImageAsset | undefined
  const regeneratedImages: NoteImageAsset[] = []
  const replacedLegacyImages: NoteImageAsset[] = []
  let newFilePath: string | undefined
  const summary: Record<string, unknown> = { ...note, updatedAt: new Date().toISOString() }
  summary.searchTerms = buildKmsSearchTerms(note.title || '', note.hashtags || [])
  summary.tagPaths = buildKmsTagPaths(note.hashtags || [])
  summary.isUntagged = (note.hashtags?.length ?? 0) === 0
  delete summary.id
  delete summary.content
  delete summary.contentDoc
  delete summary.assets
  const body: Record<string, unknown> = {
    content: note.content || '',
    ...(note.contentDoc ? { contentDoc: note.contentDoc } : {}),
    assets: note.assets || [],
  }

  try {
    let bodyAssets = [...(note.assets || [])]
    for (const oldAsset of bodyAssets.filter(asset => !asset.storagePath.startsWith('users/'))) {
      const sourceUrl = oldAsset.downloadUrl
      if (!sourceUrl) continue
      const file = await downloadAsFile(sourceUrl, oldAsset.originalName || `legacy-image-${oldAsset.id}.jpg`, oldAsset.mimeType || 'image/jpeg')
      const replacement = await prepareAndUploadNoteImage(file, note.id, value => onProgress(value * 0.45))
      regeneratedImages.push(replacement)
      replacedLegacyImages.push(oldAsset)
      bodyAssets = bodyAssets.map(asset => asset.id === oldAsset.id ? replacement : asset)
      if (summary.coverAssetId === oldAsset.id) summary.coverAssetId = replacement.id
    }
    body.assets = bodyAssets

    if (migrateImage && note.imageUrl) {
      const imageFile = await downloadAsFile(note.imageUrl, `legacy-cover-${note.id}.jpg`, 'image/jpeg')
      newImage = await prepareAndUploadNoteImage(imageFile, note.id, value => onProgress(value * 0.55))
      summary.imageUrl = newImage.downloadUrl
      summary.coverAssetId = newImage.id
      if (newImage.thumbnailUrl) summary.coverThumbnailUrl = newImage.thumbnailUrl
      else delete summary.coverThumbnailUrl
      body.assets = [...bodyAssets, newImage]
    }

    if (migrateFile && note.fileUrl) {
      const file = await downloadAsFile(note.fileUrl, note.fileName || `legacy-file-${note.id}`)
      const uploaded = await uploadPrivateNoteFile(file, note.id, value => onProgress(0.55 + value * 0.4))
      newFilePath = uploaded.storagePath
      summary.fileUrl = uploaded.downloadUrl
      summary.fileStoragePath = uploaded.storagePath
      summary.fileName = note.fileName || uploaded.originalName
    }

    const migratedAssets = body.assets as NoteImageAsset[]
    const cover = migratedAssets.find(asset => asset.id === summary.coverAssetId)
    const articlePreview = migratedAssets.find(asset => asset.id !== summary.coverAssetId)
    if (cover?.thumbnailUrl) summary.coverThumbnailUrl = cover.thumbnailUrl
    if (articlePreview?.thumbnailUrl) summary.articleThumbnailUrl = articlePreview.thumbnailUrl

    const batch = writeBatch(kmsDB)
    batch.set(userDoc(kmsDB, 'notes', note.id), summary)
    batch.set(userDoc(kmsDB, 'noteBodies', note.id), body)
    await batch.commit()
    await finalizeNoteImageAssets([...regeneratedImages, ...(newImage ? [newImage] : [])]).catch(error => {
      console.warn('遷移已完成，但圖片草稿標記稍後才會清理', error)
    })
    onProgress(1)

    await Promise.allSettled([
      tryDeleteLegacyUrl(migrateImage ? note.imageUrl : undefined),
      tryDeleteLegacyUrl(migrateFile ? note.fileUrl : undefined),
      replacedLegacyImages.length ? deleteNoteImageAssets(replacedLegacyImages) : Promise.resolve(),
    ])
  } catch (error) {
    await Promise.allSettled([
      newImage || regeneratedImages.length ? deleteNoteImageAssets([...regeneratedImages, ...(newImage ? [newImage] : [])]) : Promise.resolve(),
      newFilePath ? deleteStoragePath(newFilePath) : Promise.resolve(),
    ])
    throw error
  }
}
