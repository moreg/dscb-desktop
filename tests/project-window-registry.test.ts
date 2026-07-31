import { describe, expect, it, vi } from 'vitest'
import { ProjectWindowRegistry, type ProjectWindowLike } from '../src/main/data/project-window-registry'

function makeWindow(): ProjectWindowLike & { destroyed: boolean; minimized: boolean } {
  return {
    destroyed: false,
    minimized: false,
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    restore: vi.fn(function (this: { minimized: boolean }) { this.minimized = false }),
    show: vi.fn(),
    focus: vi.fn()
  }
}

describe('ProjectWindowRegistry', () => {
  it('allows different projects in different windows', () => {
    const registry = new ProjectWindowRegistry<ProjectWindowLike>()
    const first = makeWindow()
    const second = makeWindow()

    expect(registry.bind(first, 'book-a')).toBeNull()
    expect(registry.bind(second, 'book-b')).toBeNull()
    expect(registry.get('book-a')).toBe(first)
    expect(registry.get('book-b')).toBe(second)
  })

  it('rejects a second window for the same project', () => {
    const registry = new ProjectWindowRegistry<ProjectWindowLike>()
    const owner = makeWindow()
    const duplicate = makeWindow()

    registry.bind(owner, 'book-a')
    expect(registry.bind(duplicate, 'book-a')).toBe(owner)
    expect(registry.projectOf(duplicate)).toBeNull()
  })

  it('releases the old project when a window returns to the library', () => {
    const registry = new ProjectWindowRegistry<ProjectWindowLike>()
    const window = makeWindow()

    registry.bind(window, 'book-a')
    registry.bind(window, null)
    expect(registry.get('book-a')).toBeNull()
  })

  it('drops destroyed owners so a project can be reopened', () => {
    const registry = new ProjectWindowRegistry<ProjectWindowLike>()
    const oldWindow = makeWindow()
    const newWindow = makeWindow()

    registry.bind(oldWindow, 'book-a')
    oldWindow.destroyed = true
    expect(registry.bind(newWindow, 'book-a')).toBeNull()
    expect(registry.get('book-a')).toBe(newWindow)
  })

  it('restores and focuses an existing project window', () => {
    const registry = new ProjectWindowRegistry<ProjectWindowLike>()
    const window = makeWindow()
    window.minimized = true

    registry.focus(window)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })
})
