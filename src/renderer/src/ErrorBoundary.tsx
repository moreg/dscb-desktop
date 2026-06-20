import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  err: Error | null
}

/**
 * 错误边界：捕获子组件渲染时的 JS 错误，避免整个白屏。
 * 出错时显示错误堆栈，方便排查。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null }

  static getDerivedStateFromError(err: Error): State {
    return { err }
  }

  componentDidCatch(err: Error, info: { componentStack?: string }): void {
    // 主进程控制台也能看到
    console.error('[ErrorBoundary]', err, info.componentStack)
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
              background: 'var(--paper-soft)',
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