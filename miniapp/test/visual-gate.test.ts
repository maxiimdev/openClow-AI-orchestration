/**
 * Visual gate integration test.
 *
 * Validates that the visual-diff-gate.sh script:
 * 1. Exists and is executable
 * 2. The playwright config has correct threshold settings
 * 3. All baseline screenshots exist for every visual test
 * 4. Baselines use deterministic filenames matching the spec
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SCREENSHOT_DIR = join(ROOT, 'e2e', '__screenshots__', 'visual.spec.ts')
const GATE_SCRIPT = join(ROOT, 'scripts', 'visual-diff-gate.sh')
const PW_CONFIG = join(ROOT, 'playwright.config.ts')

describe('visual gate infrastructure', () => {
  it('gate script exists and is executable', () => {
    expect(existsSync(GATE_SCRIPT)).toBe(true)
    const stat = statSync(GATE_SCRIPT)
    expect(stat.mode & 0o100).toBeTruthy()
  })

  it('playwright config has toHaveScreenshot thresholds', () => {
    const config = readFileSync(PW_CONFIG, 'utf-8')
    expect(config).toContain('maxDiffPixelRatio')
    expect(config).toContain('threshold')
    expect(config).toContain("animations: 'disabled'")
  })

  it('playwright config defines mobile and desktop projects', () => {
    const config = readFileSync(PW_CONFIG, 'utf-8')
    expect(config).toContain("name: 'chromium'")
    expect(config).toContain("name: 'chromium-desktop'")
    expect(config).toContain('390')
    expect(config).toContain('844')
    expect(config).toContain('1280')
    expect(config).toContain('720')
  })

  it('baseline screenshot directory exists', () => {
    expect(existsSync(SCREENSHOT_DIR)).toBe(true)
  })

  it('all populated-state baselines are present', () => {
    const files = readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'))
    const fileSet = new Set(files)

    const populated = [
      'dashboard-chromium.png',
      'dashboard-chromium-desktop.png',
      'tasks-list-chromium.png',
      'tasks-list-chromium-desktop.png',
      'task-detail-chromium.png',
      'task-detail-chromium-desktop.png',
      'inbox-chromium.png',
      'inbox-chromium-desktop.png',
      'reviews-chromium.png',
      'reviews-chromium-desktop.png',
    ]

    for (const f of populated) {
      expect(fileSet.has(f), 'Missing baseline: ' + f).toBe(true)
    }
  })

  it('all empty-state baselines are present', () => {
    const files = readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'))
    const fileSet = new Set(files)

    const emptyState = [
      'dashboard-empty-chromium.png',
      'dashboard-empty-chromium-desktop.png',
      'tasks-list-empty-chromium.png',
      'tasks-list-empty-chromium-desktop.png',
      'inbox-empty-chromium.png',
      'inbox-empty-chromium-desktop.png',
      'reviews-empty-chromium.png',
      'reviews-empty-chromium-desktop.png',
    ]

    for (const f of emptyState) {
      expect(fileSet.has(f), 'Missing empty-state baseline: ' + f).toBe(true)
    }
  })

  it('total baseline count is 18 (10 populated + 8 empty)', () => {
    const files = readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'))
    expect(files.length).toBe(18)
  })

  it('baseline files are non-trivial size (>1KB)', () => {
    const files = readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'))
    for (const f of files) {
      const stat = statSync(join(SCREENSHOT_DIR, f))
      expect(stat.size, f + ' too small (' + stat.size + ' bytes)').toBeGreaterThan(1024)
    }
  })

  it('visual.spec.ts uses fixed timestamps (not new Date())', () => {
    const spec = readFileSync(join(ROOT, 'e2e', 'visual.spec.ts'), 'utf-8')
    expect(spec).not.toContain('new Date()')
    expect(spec).toContain('2026-01-15T10:00:00.000Z')
  })

  it('gate script supports --json flag', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8')
    expect(script).toContain('--json')
    expect(script).toContain('visual-report.json')
  })

  it('gitignore excludes test artifacts but not baselines', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('e2e/results/')
    expect(gitignore).toContain('e2e/test-results/')
    expect(gitignore).toContain('e2e/visual-report.json')
    expect(gitignore).not.toContain('__screenshots__')
  })
})
