import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWebViewport } from '../src/renderer/src/web-viewport'

afterEach(() => vi.unstubAllGlobals())

describe('web visual viewport', () => {
  function fixture(visual = true) {
    const properties = new Map<string, string>()
    const classes = new Set<string>()
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 })
    const media = Object.assign(new EventTarget(), { matches: true })
    let queued: (() => void) | undefined
    const win = Object.assign(new EventTarget(), {
      innerHeight: 800, visualViewport: visual ? viewport : undefined,
      matchMedia: () => media,
      requestAnimationFrame: (callback: () => void) => { queued = callback; return 1 },
      cancelAnimationFrame: () => { queued = undefined }
    })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', { documentElement: {
      classList: { toggle: (key: string, enabled: boolean) => enabled ? classes.add(key) : classes.delete(key), remove: (key: string) => classes.delete(key) },
      style: { setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) }
    } })
    return { properties, classes, viewport, media, win, flush: () => { const fn = queued; queued = undefined; fn?.() } }
  }
  it('keeps overlays inside the visible area after keyboard resize and viewport scrolling', () => {
    const f = fixture(), stop = installWebViewport()
    f.viewport.height = 350; f.viewport.offsetTop = 90
    f.viewport.dispatchEvent(new Event('resize')); f.viewport.dispatchEvent(new Event('scroll')); f.flush()
    expect(f.properties.get('--web-viewport-height')).toBe('350px')
    expect(f.properties.get('--web-viewport-top')).toBe('90px')
    f.viewport.height = 800; f.viewport.offsetTop = 0
    f.viewport.dispatchEvent(new Event('resize')); f.flush()
    expect(f.properties.get('--web-viewport-height')).toBe('800px')
    stop()
  })
  it('does not shrink the writing canvas during native pinch zoom', () => {
    const f = fixture(), stop = installWebViewport()
    f.viewport.scale = 2; f.viewport.height = 400
    f.viewport.dispatchEvent(new Event('resize')); f.flush()
    expect(f.properties.get('--web-viewport-height')).toBe('800px')
    stop()
  })
  it('handles rotation and browsers without VisualViewport, and cleans up listeners', () => {
    const f = fixture(false), stop = installWebViewport()
    f.win.innerHeight = 400; f.media.matches = false
    f.win.dispatchEvent(new Event('resize')); f.media.dispatchEvent(new Event('change')); f.flush()
    expect(f.classes.has('dscb-mobile')).toBe(false)
    expect(f.properties.get('--web-viewport-height')).toBe('400px')
    stop()
    f.media.matches = true; f.media.dispatchEvent(new Event('change')); f.win.dispatchEvent(new Event('resize')); f.flush()
    expect(f.classes.has('dscb-mobile')).toBe(false)
    expect(f.properties.size).toBe(0)
  })
})
