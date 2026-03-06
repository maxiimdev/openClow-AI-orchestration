import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { setDb, closeDb } from '../server/lib/search-db'
import { indexArtifact, indexTaskArtifacts, searchTaskArtifacts, getIndexedArtifacts } from '../server/lib/indexer'
import type { Artifact } from '../app/lib/types'

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    name: 'report.md',
    kind: 'markdown',
    path: '/out/report.md',
    bytes: 1024,
    sha256: 'abc123',
    preview: 'Summary of report...',
    ...overrides,
  }
}

describe('indexer', () => {
  beforeEach(() => {
    const db = new Database(':memory:')
    setDb(db)
  })

  afterEach(() => {
    closeDb()
  })

  describe('indexArtifact', () => {
    it('indexes a markdown artifact and creates chunks', () => {
      const content = '## Setup\nInstall node.\n\n## Usage\nRun npm start.'
      const result = indexArtifact({
        taskId: 'task-1',
        artifact: makeArtifact(),
        content,
      })

      expect(result.artifactId).toBeGreaterThan(0)
      expect(result.chunkCount).toBe(2)
    })

    it('skips re-indexing the same artifact', () => {
      const content = '## Setup\nInstall node.'
      const first = indexArtifact({ taskId: 'task-1', artifact: makeArtifact(), content })
      const second = indexArtifact({ taskId: 'task-1', artifact: makeArtifact(), content })

      expect(second.artifactId).toBe(first.artifactId)
      expect(second.chunkCount).toBe(first.chunkCount)
    })

    it('indexes log artifacts with line-window chunking', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `[INFO] event ${i}`)
      const result = indexArtifact({
        taskId: 'task-1',
        artifact: makeArtifact({ name: 'build.log', kind: 'log' }),
        content: lines.join('\n'),
      })

      expect(result.chunkCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe('indexTaskArtifacts', () => {
    it('indexes multiple artifacts for a task', () => {
      const artifacts = [
        makeArtifact({ name: 'report.md', kind: 'markdown' }),
        makeArtifact({ name: 'build.log', kind: 'log' }),
      ]

      const result = indexTaskArtifacts('task-1', artifacts, (a) => {
        if (a.name === 'report.md') return '## Summary\nAll tests passed.'
        return 'Build started\nBuild finished'
      })

      expect(result.indexed).toBe(2)
      expect(result.totalChunks).toBeGreaterThanOrEqual(2)
    })
  })

  describe('searchTaskArtifacts', () => {
    it('returns ranked results matching query', () => {
      indexArtifact({
        taskId: 'task-1',
        artifact: makeArtifact({ name: 'report.md', kind: 'markdown' }),
        content: '## Summary\nAll tests passed successfully.\n\n## Errors\nNo errors found.',
      })

      const results = searchTaskArtifacts('task-1', 'tests passed')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].artifactName).toBe('report.md')
      expect(results[0].section).toBe('Summary')
      expect(results[0].snippet).toContain('tests')
    })

    it('returns empty array for no matches', () => {
      indexArtifact({
        taskId: 'task-1',
        artifact: makeArtifact(),
        content: '## Setup\nInstall deps.',
      })

      const results = searchTaskArtifacts('task-1', 'nonexistent_query_xyz')
      expect(results).toEqual([])
    })

    it('scopes results to the given task', () => {
      indexArtifact({
        taskId: 'task-1',
        artifact: makeArtifact({ name: 'a.md' }),
        content: '## Alpha\nShared keyword banana.',
      })
      indexArtifact({
        taskId: 'task-2',
        artifact: makeArtifact({ name: 'b.md' }),
        content: '## Beta\nShared keyword banana.',
      })

      const results = searchTaskArtifacts('task-1', 'banana')
      expect(results).toHaveLength(1)
      expect(results[0].artifactName).toBe('a.md')
    })

    it('respects limit parameter', () => {
      indexArtifact({
        taskId: 'task-1',
        artifact: makeArtifact(),
        content: '## A\nerror found\n## B\nerror again\n## C\nerror here too',
      })

      const results = searchTaskArtifacts('task-1', 'error', 1)
      expect(results).toHaveLength(1)
    })
  })

  describe('getIndexedArtifacts', () => {
    it('returns artifact metadata for a task', () => {
      indexArtifact({
        taskId: 'task-1',
        artifact: makeArtifact({ name: 'report.md', kind: 'markdown', bytes: 2048 }),
        content: '## Content\nSome text.',
      })

      const artifacts = getIndexedArtifacts('task-1')
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].name).toBe('report.md')
      expect(artifacts[0].kind).toBe('markdown')
      expect(artifacts[0].bytes).toBe(2048)
    })

    it('returns empty array for unknown task', () => {
      expect(getIndexedArtifacts('nonexistent')).toEqual([])
    })
  })
})
