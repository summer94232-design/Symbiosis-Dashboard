/**
 * 在篩選畫面拖曳時，只交換可見項目在完整序列中原本佔用的插槽。
 * 隱藏項目保持相對位置，最後為全部項目建立唯一、連續的 order。
 */
export function reorderVisibleItems<T extends { id: string; order: number }>(
    allItems: T[],
    visibleItems: T[],
    activeId: string,
    overId: string,
): T[] | null {
    const oldIndex = visibleItems.findIndex(item => item.id === activeId)
    const newIndex = visibleItems.findIndex(item => item.id === overId)
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return null

    const reorderedVisible = [...visibleItems]
    const [moved] = reorderedVisible.splice(oldIndex, 1)
    reorderedVisible.splice(newIndex, 0, moved)

    const visibleIds = new Set(reorderedVisible.map(item => item.id))
    let visibleCursor = 0
    return allItems
        .map(item => visibleIds.has(item.id) ? reorderedVisible[visibleCursor++] : item)
        .map((item, index) => ({ ...item, order: index }))
}
