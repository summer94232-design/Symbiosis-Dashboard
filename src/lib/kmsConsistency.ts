import { writeBatch } from 'firebase/firestore'
import { kmsDB } from './firebase'
import { userDoc } from './userDB'
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
  invalidateAllKmsData()
  const [notes, trash] = await Promise.all([
    fetchKmsNotes<RepairNote>(),
    fetchKmsTrash<RepairTrash>(),
  ])

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
      trashToDelete.add(item.id)
      removedExpiredTrash++
    }
  }

  let batch = writeBatch(kmsDB)
  let operations = 0
  const flush = async () => {
    if (!operations) return
    await batch.commit()
    batch = writeBatch(kmsDB)
    operations = 0
  }

  for (const noteId of changedNotes) {
    batch.update(userDoc(kmsDB, 'notes', noteId), {
      links: linksById.get(noteId) ?? [],
      updatedAt: now.toISOString(),
    })
    operations++
    if (operations >= 400) await flush()
  }
  for (const trashId of trashToDelete) {
    batch.delete(userDoc(kmsDB, 'trash', trashId))
    operations++
    if (operations >= 400) await flush()
  }
  await flush()
  invalidateAllKmsData()

  return {
    repairedNotes: changedNotes.size,
    removedBrokenLinks,
    addedBacklinks,
    removedTrashCollisions,
    removedExpiredTrash,
  }
}
