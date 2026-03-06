import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const APP_DIR = join(__dirname, '..', 'app')
const CSS_PATH = join(APP_DIR, 'assets', 'css', 'main.css')

/** Recursively collect .vue files from a directory */
function collectVueFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectVueFiles(full))
    } else if (extname(full) === '.vue') {
      files.push(full)
    }
  }
  return files
}

describe('CSS pipeline sanity', () => {
  const css = readFileSync(CSS_PATH, 'utf-8')

  it('imports tailwindcss v4', () => {
    expect(css).toContain('@import "tailwindcss"')
  })

  it('defines all required design tokens in @theme', () => {
    const requiredTokens = [
      '--color-background',
      '--color-foreground',
      '--color-card',
      '--color-card-foreground',
      '--color-primary',
      '--color-primary-foreground',
      '--color-secondary',
      '--color-secondary-foreground',
      '--color-muted',
      '--color-muted-foreground',
      '--color-accent',
      '--color-accent-foreground',
      '--color-destructive',
      '--color-destructive-foreground',
      '--color-border',
      '--color-input',
      '--color-ring',
      '--color-success',
      '--color-success-foreground',
      '--color-success-muted',
      '--color-success-muted-foreground',
      '--color-warning',
      '--color-warning-foreground',
      '--color-warning-muted',
      '--color-warning-muted-foreground',
      '--color-info',
      '--color-info-foreground',
      '--color-info-muted',
      '--color-info-muted-foreground',
      '--color-severity-critical',
      '--color-severity-critical-muted',
      '--color-severity-critical-foreground',
      '--color-severity-major',
      '--color-severity-major-muted',
      '--color-severity-major-foreground',
      '--color-severity-minor',
      '--color-severity-minor-muted',
      '--color-severity-minor-foreground',
      '--radius',
    ]
    for (const token of requiredTokens) {
      expect(css, `missing token: ${token}`).toContain(token)
    }
  })

  it('sets default border-color in base layer', () => {
    expect(css).toContain('border-color: var(--color-border)')
  })

  it('sets body background and color from tokens', () => {
    expect(css).toContain('background-color: var(--color-background)')
    expect(css).toContain('color: var(--color-foreground)')
  })

  it('does not contain legacy @nuxtjs/tailwindcss references', () => {
    expect(css).not.toContain('@nuxtjs/tailwindcss')
  })
})

describe('no raw Tailwind palette colors in app code', () => {
  const vueFiles = collectVueFiles(APP_DIR)

  // Match any raw Tailwind color palette class (bg-red-500, text-blue-100, border-amber-200, etc.)
  const rawPalettePattern = /\b(?:bg|text|border|ring|outline)-(red|blue|green|amber|orange|yellow|gray|white|slate|zinc|stone|neutral|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|lime)-\d{2,3}\b/

  for (const file of vueFiles) {
    const relPath = file.replace(APP_DIR + '/', '')
    const content = readFileSync(file, 'utf-8')

    it(`${relPath} does not use raw Tailwind palette colors`, () => {
      // Check both template and script sections (for dynamic class maps)
      expect(content, `${relPath} contains raw palette color`).not.toMatch(rawPalettePattern)
    })
  }

  it('no bg-white in templates', () => {
    for (const file of vueFiles) {
      const content = readFileSync(file, 'utf-8')
      const templateMatch = content.match(/<template>([\s\S]*?)<\/template>/)
      if (!templateMatch) continue
      expect(templateMatch[1]).not.toMatch(/\bbg-white\b/)
    }
  })
})
