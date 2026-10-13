import { runTransaction } from 'firebase/firestore'
import { kmsDB } from './firebase'
import { captureUserSession } from './userDB'
import { deleteStoragePath } from './kmsImages'

/** A durable deletion claim prevents restore once any attachment might be gone. */
export async function purgeKmsTrash(id: string, session = captureUserSession()): Promise<void> {
    const trashRef = session.doc(kmsDB, 'trash', id)
    const noteRef = session.doc(kmsDB, 'notes', id)
    const bodyRef = session.doc(kmsDB, 'noteBodies', id)
    const paths = await runTransaction(kmsDB, async tx => {
        session.assertActive()
        const [trash, note, body] = await Promise.all([tx.get(trashRef), tx.get(noteRef), tx.get(bodyRef)])
        session.assertActive()
        if (note.exists()) throw new Error('筆記已復原，已停止清理。')
        if (!trash.exists()) return []
        const data = trash.data()
        if (data.purgeState === 'deleting' && Array.isArray(data.purgePaths)) return data.purgePaths as string[]
        const records = [data, body.exists() ? body.data() : {}]
        const paths = [...new Set(records.flatMap(record => [record.fileStoragePath,
            ...(Array.isArray(record.assets) ? record.assets.flatMap(asset => [asset.storagePath, asset.thumbnailPath]) : []),
        ]).filter((path): path is string => typeof path === 'string' && !!path))]
        tx.update(trashRef, { purgeState: 'deleting', purgePaths: paths })
        return paths
    })
    for (const path of paths) {
        session.assertActive()
        await deleteStoragePath(path)
        session.assertActive()
    }
    await runTransaction(kmsDB, async tx => {
        session.assertActive()
        const [trash, note] = await Promise.all([tx.get(trashRef), tx.get(noteRef)])
        session.assertActive()
        if (note.exists()) throw new Error('偵測到同 ID 筆記，停止完成清理，請核對資料。')
        if (!trash.exists()) return
        if (trash.data().purgeState !== 'deleting') throw new Error('清理狀態已改變，請重試。')
        tx.delete(bodyRef)
        tx.delete(trashRef)
    })
    session.assertActive()
}
