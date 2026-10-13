import { purgeKmsTrash } from './kmsPurge'
import { runTransaction } from 'firebase/firestore'
import { kmsDB } from './firebase'
import { captureUserSession } from './userDB'
import { fetchKmsNotes, fetchKmsTrash, invalidateAllKmsData } from './kmsData'

interface RepairNote {
  id: string
  links?: string[]
  [key: string]: unknown
}

interface RepairTrash {
  id: string
  deletedAt?: string
  [key: string]: unknown
}

export interface KmsRepairResult {
  repairedNotes: number
  removedBrokenLinks: number
  addedBacklinks: number
  removedTrashCollisions: number
  removedExpiredTrash: number
}

/**
 * Repairs only deterministic KMS consistency problems:
 * - nonexistent/self links are removed;
 * - missing reverse links are added;
 * - when an active note and trash share an ID, the active note wins;
 * - valid trash timestamps older than 30 days are removed.
 *
 * Ambiguous content conflicts are never rewritten automatically.
 */
export async function repairKmsConsistency(now = new Date()): Promise<KmsRepairResult> {
  const session = captureUserSession()
  invalidateAllKmsData()
  const [notes, trash] = await Promise.all([
    fetchKmsNotes<RepairNote>(),
    fetchKmsTrash<RepairTrash>(),
  ])

  session.assertActive()
  const noteIds = new Set(notes.map(note => note.id))
  const linksById = new Map(notes.map(note => [
    note.id,
    [...new Set(Array.isArray(note.links) ? note.links.map(String) : [])],
  ]))
  const changedNotes = new Set<string>()
  let removedBrokenLinks = 0
  let addedBacklinks = 0

  for (const note of notes) {
    const current = linksById.get(note.id) ?? []
    const valid = current.filter(targetId => {
      const keep = targetId !== note.id && noteIds.has(targetId)
      if (!keep) removedBrokenLinks++
      return keep
    })
    if (valid.length !== current.length) {
      linksById.set(note.id, valid)
      changedNotes.add(note.id)
    }
  }

  for (const [sourceId, targetIds] of linksById) {
    for (const targetId of targetIds) {
      const targetLinks = linksById.get(targetId)
      if (targetLinks && !targetLinks.includes(sourceId)) {
        linksById.set(targetId, [...targetLinks, sourceId])
        changedNotes.add(targetId)
        addedBacklinks++
      }
    }
  }

  const trashToDelete = new Set<string>()
  const expired = new Set<string>()
  let removedTrashCollisions = 0
  let removedExpiredTrash = 0
  for (const item of trash) {
    if (noteIds.has(item.id)) {
      trashToDelete.add(item.id)
      removedTrashCollisions++
      continue
    }
    const deletedAt = typeof item.deletedAt === 'string' ? Date.parse(item.deletedAt) : NaN
    if (!Number.isNaN(deletedAt) && now.getTime() - deletedAt > 30 * 86400000) {
      expired.add(item.id)
    }
  }

  if (changedNotes.size + trashToDelete.size > 449) throw new Error('修復範圍超過單次安全上限，請分開處理。')
  await runTransaction(kmsDB, async tx => {
    session.assertActive()
    const current = await Promise.all(notes.map(note => tx.get(session.doc(kmsDB, 'notes', note.id))))
    const collisions = await Promise.all([...trashToDelete].map(id => tx.get(session.doc(kmsDB, 'trash', id))))
    session.assertActive()
    current.forEach((snapshot, index) => {
      const original = notes[index]
      if (!snapshot.exists() || JSON.stringify(snapshot.data().links || []) !== JSON.stringify(original.links || []) || snapshot.data().updatedAt !== original.updatedAt) {
        throw new Error('筆記已被其他操作修改，請重新執行健康檢查。')
      }
    })
    for (const noteId of changedNotes) tx.update(session.doc(kmsDB, 'notes', noteId), {
      links: linksById.get(noteId) ?? [], updatedAt: now.toISOString(),
      graphRevision: (Number(notes.find(note => note.id === noteId)?.graphRevision) || 0) + 1,
    })
    // Only the duplicate trash document is removed; never its shared body or attachments.
    collisions.forEach(snapshot => { if (snapshot.exists()) tx.delete(snapshot.ref) })
  })
  for (const id of expired) {
    session.assertActive()
    await purgeKmsTrash(id, session)
    removedExpiredTrash++
  }
  session.assertActive()
  invalidateAllKmsData()

  return {
    repairedNotes: changedNotes.size,
    removedBrokenLinks,
    addedBacklinks,
    removedTrashCollisions,
    removedExpiredTrash,
  }
}
