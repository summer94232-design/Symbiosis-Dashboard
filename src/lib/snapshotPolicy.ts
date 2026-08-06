export type AutoSnapshotTrigger = 'background' | 'price-update'

/** 背景補寫時段；使用者明確更新現價時不受此限制。 */
export function isWithinAutoSnapshotWindow(now: Date = new Date()): boolean {
  const hour = now.getHours()
  return hour >= 8 && hour < 22
}

export function canRunAutoSnapshot(
  trigger: AutoSnapshotTrigger,
  now: Date = new Date(),
): boolean {
  return trigger === 'price-update' || isWithinAutoSnapshotWindow(now)
}
