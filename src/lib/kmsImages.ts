import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from 'firebase/storage'
import { deleteDoc, getDoc, setDoc } from 'firebase/firestore'
import { kmsAuth } from './auth'
import { kmsDB, kmsStorage } from './firebase'
import { userDoc } from './userDB'

export interface NoteImageAsset {
  id: string
  storagePath: string
  thumbnailPath: string
  downloadUrl: string
  thumbnailUrl: string
  width: number
  height: number
  size: number
  thumbnailSize: number
  mimeType: string
  originalName: string
}

export interface NoteFileAsset {
  storagePath: string
  downloadUrl: string
  originalName: string
  size: number
  mimeType: string
}

interface EncodedImage {
  blob: Blob
  width: number
  height: number
  extension: 'webp' | 'jpg'
}

const MAX_SOURCE_BYTES = 40 * 1024 * 1024
const MAX_SOURCE_PIXELS = 50_000_000
const MAIN_MAX_EDGE = 2048
const MAIN_TARGET_BYTES = 1.5 * 1024 * 1024
const THUMB_MAX_EDGE = 480
const THUMB_TARGET_BYTES = 180 * 1024
const UPLOAD_DRAFT_KEY = 'kms:image-upload-drafts'
const UPLOAD_DRAFT_COLLECTION = 'imageUploadDrafts'
const STALE_UPLOAD_HOURS = 24
const MAX_FILE_BYTES = 50 * 1024 * 1024

interface ImageUploadDraft {
  assetId: string
  noteId: string
  storagePath: string
  thumbnailPath: string
  createdAt: string
}

function isHeif(file: File): boolean {
  return /image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
}

async function normalizeSource(file: File): Promise<Blob> {
  if (!isHeif(file)) return file

  const { default: heic2any } = await import('heic2any')
  const result = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.92,
  })
  const converted = Array.isArray(result) ? result[0] : result
  if (!converted) throw new Error('無法讀取這張 HEIC／HEIF 圖片')
  return converted
}

async function decodeImage(blob: Blob): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  cleanup: () => void
}> {
  const objectUrl = URL.createObjectURL(blob)
  const image = new window.Image()
  image.decoding = 'async'
  image.src = objectUrl
  await image.decode()
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    cleanup: () => URL.revokeObjectURL(objectUrl),
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('瀏覽器無法完成圖片壓縮'))
    }, type, quality)
  })
}

async function encodeImage(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
  targetBytes: number,
): Promise<EncodedImage> {
  const initialScale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight))
  let width = Math.max(1, Math.round(sourceWidth * initialScale))
  let height = Math.max(1, Math.round(sourceHeight * initialScale))
  let best: Blob | null = null
  let bestWidth = width
  let bestHeight = height
  let mimeType = 'image/webp'

  for (let sizeAttempt = 0; sizeAttempt < 4; sizeAttempt += 1) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('瀏覽器無法建立圖片處理區')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    context.drawImage(source, 0, 0, width, height)

    for (const quality of [0.84, 0.76, 0.68, 0.6]) {
      let encoded = await canvasToBlob(canvas, 'image/webp', quality)
      if (encoded.type !== 'image/webp') {
        mimeType = 'image/jpeg'
        encoded = await canvasToBlob(canvas, mimeType, quality)
      }
      if (!best || encoded.size < best.size) {
        best = encoded
        bestWidth = width
        bestHeight = height
      }
      if (encoded.size <= targetBytes) {
        return {
          blob: encoded,
          width,
          height,
          extension: mimeType === 'image/webp' ? 'webp' : 'jpg',
        }
      }
    }

    width = Math.max(1, Math.round(width * 0.82))
    height = Math.max(1, Math.round(height * 0.82))
  }

  if (!best) throw new Error('圖片壓縮失敗')
  return {
    blob: best,
    width: bestWidth,
    height: bestHeight,
    extension: mimeType === 'image/webp' ? 'webp' : 'jpg',
  }
}

async function uploadBlob(
  path: string,
  blob: Blob,
  onProgress: (progress: number) => void,
): Promise<string> {
  const storageRef = ref(kmsStorage, path)
  const task = uploadBytesResumable(storageRef, blob, {
    contentType: blob.type,
    cacheControl: 'private,max-age=31536000,immutable',
  })

  await new Promise<void>((resolve, reject) => {
    task.on(
      'state_changed',
      snapshot => onProgress(snapshot.totalBytes ? snapshot.bytesTransferred / snapshot.totalBytes : 0),
      reject,
      resolve,
    )
  })
  return getDownloadURL(storageRef)
}

function safeFileName(name: string): string {
  const normalized = name.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '_')
  return normalized.slice(-120) || 'attachment'
}

export async function uploadPrivateNoteFile(
  file: File,
  noteId: string,
  onProgress: (progress: number) => void = () => undefined,
): Promise<NoteFileAsset> {
  const uid = kmsAuth.currentUser?.uid
  if (!uid) throw new Error('請先登入知識庫帳號')
  if (file.size > MAX_FILE_BYTES) throw new Error('文件不可超過 50 MB')

  const storagePath = `users/${uid}/notes/${noteId}/files/${crypto.randomUUID()}_${safeFileName(file.name)}`
  const downloadUrl = await uploadBlob(storagePath, file, onProgress)
  return {
    storagePath,
    downloadUrl,
    originalName: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
  }
}

export async function deleteStoragePath(storagePath: string): Promise<void> {
  try {
    await deleteObject(ref(kmsStorage, storagePath))
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
    if (code !== 'storage/object-not-found') throw error
  }
}

function uploadDraftStorageKey(): string {
  return `${UPLOAD_DRAFT_KEY}:${kmsAuth.currentUser?.uid || 'signed-out'}`
}

function readUploadDrafts(): ImageUploadDraft[] {
  try {
    const rows = JSON.parse(localStorage.getItem(uploadDraftStorageKey()) || '[]')
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

async function registerUploadDraft(draft: ImageUploadDraft): Promise<void> {
  const rows = readUploadDrafts().filter(row => row.assetId !== draft.assetId)
  localStorage.setItem(uploadDraftStorageKey(), JSON.stringify([...rows, draft]))
  await setDoc(userDoc(kmsDB, UPLOAD_DRAFT_COLLECTION, draft.assetId), draft).catch(error => {
    // 規則／後端尚未部署時仍保留本機清理能力，不阻斷正常上傳。
    console.warn('跨裝置圖片草稿登記失敗，將使用本機清理', error)
  })
}

async function removeUploadDrafts(assetIds: string[]): Promise<void> {
  const removeIds = new Set(assetIds)
  localStorage.setItem(uploadDraftStorageKey(), JSON.stringify(
    readUploadDrafts().filter(row => !removeIds.has(row.assetId)),
  ))
  await Promise.allSettled([...removeIds].map(assetId => deleteDoc(
    userDoc(kmsDB, UPLOAD_DRAFT_COLLECTION, assetId),
  )))
}

export async function prepareAndUploadNoteImage(
  file: File,
  noteId: string,
  onProgress: (progress: number) => void = () => undefined,
): Promise<NoteImageAsset> {
  const uid = kmsAuth.currentUser?.uid
  if (!uid) throw new Error('請先登入知識庫帳號')
  if (!file.type.startsWith('image/') && !isHeif(file)) throw new Error('請選擇圖片檔案')
  if (file.size > MAX_SOURCE_BYTES) throw new Error('原始圖片不可超過 40 MB')

  onProgress(0.02)
  const normalized = await normalizeSource(file)
  const decoded = await decodeImage(normalized)

  try {
    if (decoded.width * decoded.height > MAX_SOURCE_PIXELS) {
      throw new Error('圖片解析度過高，請使用 5,000 萬像素以下的圖片')
    }

    onProgress(0.08)
    const [main, thumbnail] = await Promise.all([
      encodeImage(decoded.source, decoded.width, decoded.height, MAIN_MAX_EDGE, MAIN_TARGET_BYTES),
      encodeImage(decoded.source, decoded.width, decoded.height, THUMB_MAX_EDGE, THUMB_TARGET_BYTES),
    ])
    onProgress(0.18)

    const id = crypto.randomUUID()
    const basePath = `users/${uid}/notes/${noteId}`
    const storagePath = `${basePath}/images/${id}.${main.extension}`
    const thumbnailPath = `${basePath}/thumbnails/${id}.${thumbnail.extension}`

    await registerUploadDraft({
      assetId: id,
      noteId,
      storagePath,
      thumbnailPath,
      createdAt: new Date().toISOString(),
    })

    try {
      const downloadUrl = await uploadBlob(storagePath, main.blob, progress => onProgress(0.18 + progress * 0.68))
      const thumbnailUrl = await uploadBlob(thumbnailPath, thumbnail.blob, progress => onProgress(0.86 + progress * 0.14))
      onProgress(1)

      return {
        id,
        storagePath,
        thumbnailPath,
        downloadUrl,
        thumbnailUrl,
        width: main.width,
        height: main.height,
        size: main.blob.size,
        thumbnailSize: thumbnail.blob.size,
        mimeType: main.blob.type,
        originalName: file.name,
      }
    } catch (error) {
      // 第二個檔案失敗時同步回收可能已完成的第一個檔案，避免留下孤兒資產。
      await Promise.allSettled([
        deleteObject(ref(kmsStorage, storagePath)),
        deleteObject(ref(kmsStorage, thumbnailPath)),
      ])
      await removeUploadDrafts([id])
      throw error
    }
  } finally {
    decoded.cleanup()
  }
}

export async function deleteNoteImageAssets(assets: NoteImageAsset[]): Promise<void> {
  const paths = [...new Set(assets.flatMap(asset => [asset.storagePath, asset.thumbnailPath]).filter(Boolean))]
  await Promise.all(paths.map(async path => {
    try {
      await deleteObject(ref(kmsStorage, path))
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
      if (code !== 'storage/object-not-found') throw error
    }
  }))
  await removeUploadDrafts(assets.map(asset => asset.id))
}

export async function finalizeNoteImageAssets(assets: NoteImageAsset[]): Promise<void> {
  if (!assets.length) return
  await removeUploadDrafts(assets.map(asset => asset.id))
}

/**
 * 回收 24 小時前未完成的圖片上傳。若圖片已被 notes 或 trash 引用，只移除草稿紀錄，
 * 不刪除圖片，避免 Firestore 已保存但草稿清理失敗時誤刪正式資產。
 */
export async function cleanupStaleNoteImageDrafts(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_UPLOAD_HOURS * 60 * 60 * 1000).toISOString()
  const staleDrafts = readUploadDrafts().filter(draft => draft.createdAt < cutoff).slice(0, 20)
  let removed = 0

  for (const draft of staleDrafts) {
    if (!draft.assetId || !draft.noteId || !draft.storagePath || !draft.thumbnailPath) {
      await removeUploadDrafts([draft.assetId])
      removed += 1
      continue
    }

    const [noteSnapshot, trashSnapshot] = await Promise.all([
      getDoc(userDoc(kmsDB, 'notes', draft.noteId)),
      getDoc(userDoc(kmsDB, 'trash', draft.noteId)),
    ])
    const referenced = [noteSnapshot, trashSnapshot].some(documentSnapshot => {
      if (!documentSnapshot.exists()) return false
      const assets = documentSnapshot.data().assets
      return Array.isArray(assets) && assets.some(asset => asset?.id === draft.assetId)
    })

    if (!referenced) {
      await Promise.all([draft.storagePath, draft.thumbnailPath].map(async path => {
        try {
          await deleteObject(ref(kmsStorage, path))
        } catch (error) {
          const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
          if (code !== 'storage/object-not-found') throw error
        }
      }))
    }
    await removeUploadDrafts([draft.assetId])
    removed += 1
  }

  return removed
}
