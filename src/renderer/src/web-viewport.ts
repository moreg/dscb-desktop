/** Include touch tablets/landscape phones without changing the desktop application's layout. */
export const WEB_MOBILE_QUERY = '(max-width: 760px), (max-width: 1024px) and (pointer: coarse)'

/** VisualViewport also shrinks on iOS when its keyboard overlays the layout viewport.
 * Do not resize the app during pinch zoom: the browser must retain native zoom/panning. */
export function installWebViewport(): () => void {
  const root = document.documentElement
  const media = window.matchMedia(WEB_MOBILE_QUERY)
  const viewport = window.visualViewport
  let frame = 0
  const update = () => {
    frame = 0
    root.classList.toggle('dscb-mobile', media.matches)
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return
    root.style.setProperty('--web-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
    root.style.setProperty('--web-viewport-top', `${viewport?.offsetTop ?? 0}px`)
  }
  const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update) }
  update()
  media.addEventListener('change', schedule)
  window.addEventListener('resize', schedule)
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  return () => {
    window.cancelAnimationFrame(frame)
    media.removeEventListener('change', schedule)
    window.removeEventListener('resize', schedule)
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    root.classList.remove('dscb-mobile')
    root.style.removeProperty('--web-viewport-height')
    root.style.removeProperty('--web-viewport-top')
  }
}
