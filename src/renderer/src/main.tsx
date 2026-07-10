import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './design.css'

// 已知的良性运行时警告：浏览器规范行为或第三方库噪声，不应让渲染进程崩溃。
// ResizeObserver loop：回调里又改了被观察元素尺寸，浏览器抛 warning（非致命），
// 现代浏览器只是提示，应用不应据此崩溃。
const BENIGN_ERROR_PATTERNS: RegExp[] = [
  /ResizeObserver loop completed with undelivered notifications/i,
  /ResizeObserver loop limit exceeded/i
]

function isBenignError(error: Error | any): boolean {
  const msg = (error?.message || String(error ?? '')).slice(0, 500)
  return BENIGN_ERROR_PATTERNS.some((re) => re.test(msg))
}

// 捕获全局未处理的同步 JS 异常
window.addEventListener('error', (event) => {
  const error = event.error || new Error(event.message)
  // 良性警告（如 ResizeObserver loop）直接吞掉，不触发崩溃屏。
  // 注意：浏览器对这类 warning 仍会派发 error 事件，但 event.error 可能为空。
  if (isBenignError(error) || isBenignError(event.message)) {
    event.preventDefault?.()
    return
  }
  showCrashScreen(error)
})

// 捕获未处理的 Promise 拒绝事件
window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason || new Error('Unhandled Promise Rejection')
  if (isBenignError(error)) {
    event.preventDefault?.()
    return
  }
  showCrashScreen(error)
})

function showCrashScreen(error: Error | any) {
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML = `
      <div style="padding: 24px; color: #ff4d4d; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #121214; min-height: 100vh; box-sizing: border-box; line-height: 1.5;">
        <h2 style="margin-top: 0; font-size: 20px; border-bottom: 1px solid #2e2e33; padding-bottom: 12px; color: #ff6b6b;">
          ⚠️ 渲染进程启动失败 (Renderer Crash)
        </h2>
        <p style="font-weight: bold; font-size: 15px; margin: 16px 0 8px;">
          ${error?.name || 'Error'}: ${error?.message || String(error)}
        </p>
        <pre style="background: #1e1e22; padding: 16px; border-radius: 6px; overflow: auto; max-height: 60vh; white-space: pre-wrap; font-size: 12px; color: #c9d1d9; border: 1px solid #2e2e33;">${error?.stack || '无堆栈信息'}</pre>
        <div style="margin-top: 20px; display: flex; gap: 12px;">
          <button onclick="window.location.reload()" style="padding: 8px 16px; background: #ff4d4d; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
            重新加载页面
          </button>
          <button onclick="navigator.clipboard.writeText(document.querySelector('pre').innerText).then(() => alert('已复制到剪贴板'))" style="padding: 8px 16px; background: #2e2e33; color: #c9d1d9; border: 1px solid #3b3b42; border-radius: 4px; cursor: pointer;">
            复制错误信息
          </button>
        </div>
      </div>
    `
  }
}

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
} catch (error) {
  showCrashScreen(error)
}
