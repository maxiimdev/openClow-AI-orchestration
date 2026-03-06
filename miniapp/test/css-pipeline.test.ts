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

describe('no raw gray classes in general UI chrome', () => {
  const vueFiles = collectVueFiles(APP_DIR)

  // These patterns indicate general UI chrome that should use tokens.
  // We exclude StatusBadge and severity maps (which use semantic status colors).
  const rawGrayPatterns = [
    /\bbg-white\b/,
    /\bborder-gray-\d+\b/,
  ]

  for (const file of vueFiles) {
    const relPath = file.replace(APP_DIR + '/', '')
    const content = readFileSync(file, 'utf-8')

    // Extract only template sections for checking
    const templateMatch = content.match(/<template>([\s\S]*?)<\/template>/)
    if (!templateMatch) continue
    const template = templateMatch[1]

    for (const pattern of rawGrayPatterns) {
      it(`${relPath} template does not use ${pattern.source}`, () => {
        expect(template).not.toMatch(pattern)
      })
    }
  }
})
