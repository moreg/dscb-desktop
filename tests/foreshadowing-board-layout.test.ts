import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('foreshadowing board layout', () => {
  it('uses a dedicated wide page layout for the board', async () => {
    const app = await readFile('src/renderer/src/App.tsx', 'utf-8')
    const css = await readFile('src/renderer/src/design.css', 'utf-8')

    expect(app).toContain("view.kind === 'foreshadowingBoard' ? 'foreshadowing-wide'")
    expect(css).toContain('.main-inner.foreshadowing-wide')
    expect(css).toContain('max-width: min(1680px, calc(100vw - 72px))')
  })

  it('keeps long foreshadowing columns and cards compact', async () => {
    const page = await readFile('src/renderer/src/ForeshadowingBoard.tsx', 'utf-8')
    const css = await readFile('src/renderer/src/design.css', 'utf-8')

    expect(page).toContain('className="kanban-list"')
    expect(page).toContain('className="muted kanban-card-note"')
    expect(css).toContain('max-height: clamp(560px, calc(100vh - 230px), 760px)')
    expect(css).toContain('overflow-y: auto')
    expect(css).toContain('-webkit-line-clamp: 3')
  })
})
