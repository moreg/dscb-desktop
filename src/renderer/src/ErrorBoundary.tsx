import { Component, type ReactNode } from 'react'
import { recordCrash, type StorageLike } from './crash-log'

interface Props {
  children: ReactNode
}

interface State {
  err: Error | null
}

/**
 * 错误边界：捕获子组件渲染时的 JS 错误，避免整个白屏。
 * 出错时显示错误堆栈 + 自动写入 crash log（renderer localStorage）。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null }

  static getDerivedStateFromError(err: Error): State {
    return { err }
  }

  componentDidCatch(err: Error, info: { componentStack?: string }): void {
    // 主进程控制台也能看到
    console.error('[ErrorBoundary]', err, info.componentStack)
    // P19-F：写入 crash log（renderer localStorage），用户可导出
    try {
      const storage: StorageLike | null =
        typeof window !== 'undefined' && window.localStorage
          ? window.localStorage
          : null
      recordCrash(storage, {
        at: Date.now(),
        message: err.message || String(err),
        stack: err.stack,
        componentStack: info.componentStack
      })
    } catch {
      // 静默：不能因为 log 写入失败导致二次 crash
    }
  }

  render() {
    if (this.state.err) {
      return (
        <div
          className="page"
          style={{
            fontFamily: 'ui-monospace, Consolas, monospace',
            color: 'var(--danger)'
          }}
        >
          <h2 className="section">页面渲染出错</h2>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: 'var(--surface-2)',
              padding: 16,
              borderRadius: 8,
              fontSize: 12.5,
              lineHeight: 1.6
            }}
          >
            {this.state.err.name}: {this.state.err.message}
            {'\n\n'}
            {this.state.err.stack}
          </pre>
          <button
            className="btn mt"
            onClick={() => this.setState({ err: null })}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}