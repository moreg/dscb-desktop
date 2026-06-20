import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('rhythm chart layout', () => {
  it('uses a dedicated wide page layout for the rhythm chart page', async () => {
    const app = await readFile('src/renderer/src/App.tsx', 'utf-8')
    const css = await readFile('src/renderer/src/design.css', 'utf-8')

    expect(app).toContain("view.kind === 'rhythm' ? 'rhythm-wide'")
    expect(css).toContain('.main-inner.rhythm-wide')
    expect(css).toContain('max-width: min(1680px, calc(100vw - 72px))')
  })

  it('renders the rhythm chart in a taller responsive card', async () => {
    const page = await readFile('src/renderer/src/RhythmChartPage.tsx', 'utf-8')
    const chart = await readFile('src/renderer/src/RhythmChart.tsx', 'utf-8')
    const css = await readFile('src/renderer/src/design.css', 'utf-8')

    expect(page).toContain('className="card rhythm-chart-card"')
    expect(chart).toContain('const VB_W = 1440')
    expect(chart).toContain('const VB_H = 640')
    expect(chart).toContain('className="rhythm-chart-svg"')
    expect(css).toContain('height: clamp(560px, calc(100vh - 260px), 720px)')
  })
})
