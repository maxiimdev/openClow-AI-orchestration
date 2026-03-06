/**
 * Content chunking for FTS5 indexing.
 *
 * Two strategies:
 * 1. Heading-aware (markdown): splits on ## headings, keeps heading as section label.
 * 2. Line-window (logs/text): fixed-size sliding window with overlap.
 */

export interface Chunk {
  section: string
  body: string
  index: number
}

// ── Markdown chunking ───────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.+)$/

/**
 * Split markdown content into chunks by headings.
 * Text before the first heading gets section = "(intro)".
 * Each heading starts a new chunk with its text as the section label.
 */
export function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split('\n')
  const chunks: Chunk[] = []
  let currentSection = '(intro)'
  let currentLines: string[] = []
  let index = 0

  function flush() {
    const body = currentLines.join('\n').trim()
    if (body.length > 0) {
      chunks.push({ section: currentSection, body, index: index++ })
    }
    currentLines = []
  }

  for (const line of lines) {
    const match = line.match(HEADING_RE)
    if (match) {
      flush()
      currentSection = match[2].trim()
      currentLines.push(line)
    } else {
      currentLines.push(line)
    }
  }
  flush()

  return chunks
}

// ── Line-window chunking ────────────────────────────────────────────────────

const DEFAULT_WINDOW = 30
const DEFAULT_OVERLAP = 5

/**
 * Split text into overlapping line windows.
 * Good for logs and plain text where there are no structural headings.
 */
export function chunkLines(
  content: string,
  windowSize: number = DEFAULT_WINDOW,
  overlap: number = DEFAULT_OVERLAP,
): Chunk[] {
  const lines = content.split('\n')
  if (lines.length === 0) return []

  const chunks: Chunk[] = []
  const step = Math.max(1, windowSize - overlap)
  let index = 0

  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + windowSize)
    const body = slice.join('\n').trim()
    if (body.length > 0) {
      chunks.push({
        section: `lines ${i + 1}-${Math.min(i + windowSize, lines.length)}`,
        body,
        index: index++,
      })
    }
    // If this window reached the end, stop
    if (i + windowSize >= lines.length) break
  }

  return chunks
}

// ── Auto-detect strategy ────────────────────────────────────────────────────

/**
 * Choose chunking strategy based on artifact kind.
 * - markdown → heading-aware
 * - everything else → line-window
 */
export function chunkContent(content: string, kind: string): Chunk[] {
  if (kind === 'markdown' || kind === 'md') {
    return chunkMarkdown(content)
  }
  return chunkLines(content)
}
