import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('relationship page layout', () => {
  it('uses a dedicated wide canvas layout instead of the default page width', async () => {
    const app = await readFile('src/renderer/src/App.tsx', 'utf-8')
    const css = await readFile('src/renderer/src/design.css', 'utf-8')

    expect(app).toContain("view.kind === 'relationships' ? 'relationship-wide'")
    expect(css).toContain('.main-inner.relationship-wide')
    expect(css).toContain('max-width: min(1680px, calc(100vw - 72px))')
  })

  it('sizes the relationship graph from the viewport and a larger SVG viewBox', async () => {
    const page = await readFile('src/renderer/src/RelationshipPage.tsx', 'utf-8')
    const css = await readFile('src/renderer/src/design.css', 'utf-8')

    expect(page).toContain('const GRAPH_WIDTH = 1120')
    expect(page).toContain('const GRAPH_HEIGHT = 720')
    expect(page).not.toContain('style={{ height: HEIGHT }}')
    expect(css).toContain('height: clamp(640px, calc(100vh - 180px), 860px)')
  })
})
