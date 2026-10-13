export function normalizeKmsSearch(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-TW').replace(/\s+/g, ' ')
}

export function buildKmsTagPaths(hashtags: string[] = []): string[] {
  const paths = new Set<string>()
  hashtags.forEach(tag => {
    const parts = tag.split('/').map(part => part.trim()).filter(Boolean)
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join('/')))
  })
  return [...paths]
}

export function buildKmsSearchTerms(title: string, hashtags: string[] = []): string[] {
  const terms = new Set<string>()
  const sources = [title, ...hashtags].map(normalizeKmsSearch).filter(Boolean)

  for (const source of sources) {
    const compact = source.replace(/\s+/g, '')
    for (let start = 0; start < compact.length && terms.size < 300; start += 1) {
      for (let length = 1; length <= Math.min(12, compact.length - start) && terms.size < 300; length += 1) {
        terms.add(compact.slice(start, start + length))
      }
    }
  }
  return [...terms]
}

/** Search only the fields promised by the UI; independent of the bounded legacy index. */
export function matchesKmsSummary(note: { title?: string; hashtags?: string[]; url?: string }, search: string): boolean {
  const compact = (value: string) => normalizeKmsSearch(value).replace(/\s+/g, '')
  const term = compact(search)
  return !term || [note.title || '', ...(note.hashtags || []), note.url || ''].some(value => compact(value).includes(term))
}

/** Read text nodes only; editor formatting and image metadata are not searchable prose. */
export function kmsBodyText(body: { content?: string; contentDoc?: unknown }): string {
  const parts = [typeof body.content === 'string' ? body.content : '']
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const node = value as { text?: unknown; content?: unknown }
    if (typeof node.text === 'string') parts.push(node.text)
    if (Array.isArray(node.content)) node.content.forEach(visit)
  }
  visit(body.contentDoc)
  return parts.join(' ')
}

export function matchesKmsBody(body: { content?: string; contentDoc?: unknown }, search: string): boolean {
  const compact = (value: string) => normalizeKmsSearch(value).replace(/\s+/g, '')
  return compact(kmsBodyText(body)).includes(compact(search))
}

