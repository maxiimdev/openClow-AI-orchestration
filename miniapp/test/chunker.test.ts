import { describe, it, expect } from 'vitest'
import { chunkMarkdown, chunkLines, chunkContent } from '../server/lib/chunker'

describe('chunkMarkdown', () => {
  it('splits content by headings', () => {
    const md = [
      '# Title',
      'Intro text.',
      '',
      '## Setup',
      'Install deps.',
      '',
      '## Usage',
      'Run the app.',
    ].join('\n')

    const chunks = chunkMarkdown(md)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].section).toBe('Title')
    expect(chunks[0].body).toContain('Intro text.')
    expect(chunks[1].section).toBe('Setup')
    expect(chunks[1].body).toContain('Install deps.')
    expect(chunks[2].section).toBe('Usage')
    expect(chunks[2].body).toContain('Run the app.')
  })

  it('puts text before first heading in (intro)', () => {
    const md = 'Some text before any heading.\n\n## First heading\nContent.'
    const chunks = chunkMarkdown(md)
    expect(chunks[0].section).toBe('(intro)')
    expect(chunks[0].body).toContain('Some text before')
    expect(chunks[1].section).toBe('First heading')
  })

  it('returns empty array for empty content', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('   ')).toEqual([])
  })

  it('handles single heading with no body', () => {
    const chunks = chunkMarkdown('## Just a heading')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].section).toBe('Just a heading')
  })

  it('assigns sequential indices', () => {
    const md = '## A\ntext\n## B\ntext\n## C\ntext'
    const chunks = chunkMarkdown(md)
    expect(chunks.map(c => c.index)).toEqual([0, 1, 2])
  })
})

describe('chunkLines', () => {
  it('creates windowed chunks with overlap', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`)
    const content = lines.join('\n')

    const chunks = chunkLines(content, 30, 5)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0].section).toBe('lines 1-30')
    expect(chunks[1].section).toBe('lines 26-55')
  })

  it('handles content smaller than window', () => {
    const chunks = chunkLines('Line 1\nLine 2\nLine 3', 30, 5)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].section).toBe('lines 1-3')
  })

  it('returns empty for empty content', () => {
    expect(chunkLines('')).toEqual([])
  })
})

describe('chunkContent', () => {
  it('uses markdown strategy for kind=markdown', () => {
    const chunks = chunkContent('## H\nbody', 'markdown')
    expect(chunks[0].section).toBe('H')
  })

  it('uses markdown strategy for kind=md', () => {
    const chunks = chunkContent('## H\nbody', 'md')
    expect(chunks[0].section).toBe('H')
  })

  it('uses line-window strategy for kind=log', () => {
    const chunks = chunkContent('line1\nline2', 'log')
    expect(chunks[0].section).toMatch(/^lines /)
  })
})
