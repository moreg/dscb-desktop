export interface ProjectWindowLike {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

/**
 * Keeps the one-project/one-window invariant in the main process.
 *
 * A window may move back to the library (projectId = null) and later bind to
 * another project. Trying to bind a second window to an already-open project
 * returns the existing owner so callers can focus it instead.
 */
export class ProjectWindowRegistry<TWindow extends ProjectWindowLike> {
  private readonly byProject = new Map<string, TWindow>()
  private readonly byWindow = new Map<TWindow, string>()

  bind(window: TWindow, projectId: string | null): TWindow | null {
    if (projectId) {
      const existing = this.get(projectId)
      if (existing && existing !== window) return existing
    }

    this.release(window)
    if (projectId) {
      this.byProject.set(projectId, window)
      this.byWindow.set(window, projectId)
    }
    return null
  }

  get(projectId: string): TWindow | null {
    const window = this.byProject.get(projectId)
    if (!window) return null
    if (window.isDestroyed()) {
      this.release(window)
      return null
    }
    return window
  }

  projectOf(window: TWindow): string | null {
    return this.byWindow.get(window) ?? null
  }

  release(window: TWindow): void {
    const projectId = this.byWindow.get(window)
    if (projectId && this.byProject.get(projectId) === window) {
      this.byProject.delete(projectId)
    }
    this.byWindow.delete(window)
  }

  focus(window: TWindow): void {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}
