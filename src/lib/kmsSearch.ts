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
