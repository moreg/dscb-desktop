import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { recordCrash, type StorageLike } from './crash-log'
import './design.css'

// 已知的良性运行时警告：浏览器规范行为或第三方库噪声，不应让渲染进程崩溃。
// ResizeObserver loop：回调里又改了被观察元素尺寸，浏览器抛 warning（非致命），
// 现代浏览器只是提示，应用不应据此崩溃。
const BENIGN_ERROR_PATTERNS: RegExp[] = [
  /ResizeObserver loop completed with undelivered notifications/i,
  /ResizeObserver loop limit exceeded/i
]

/** error 可能是 Error、字符串（event.message）或任意被 throw 的值 */
type ThrownValue = Error | { message?: string; name?: string; stack?: string } | string | null | undefined

function errMessage(error: unknown): string {
  const maybe = error as ThrownValue
  return (typeof maybe === 'object' && maybe?.message) || String(error ?? '')
}

function isBenignError(error: unknown): boolean {
  const msg = errMessage(error).slice(0, 500)
  return BENIGN_ERROR_PATTERNS.some((re) => re.test(msg))
}

/**
 * App 是否已经挂载成功。
 *
 * 崩溃屏（showCrashScreen）会把 #root 整个 innerHTML 掉，React 从此失去挂载点，
 * 只剩"重新加载页面"一条路。这个代价只有在**启动期**才划算——那时确实没有可用界面。
 * 挂载之后，应用已经有了更合适的降级层：每个页面都套着 ErrorBoundary（可重试），
 * 各控制器也有自己的错误提示位。此时再为一次异步失败（多半是某个可选数据读取被拒）
 * 摧毁整个界面，等于用最重的手段处理最轻的问题，还会连带丢掉用户未保存的编辑状态。
 *
 * 所以挂载后只记日志、不再换屏；真正影响渲染的错误自然会被 ErrorBoundary 接住。
 */
let appMounted = false

// 同一错误短窗内只落盘一条：recordCrash 每次都同步全量读写 localStorage
// （最多 50 条含 stack），不能让它跟着错误循环（如定时器反复抛错）的频率执行。
const CRASH_LOG_DEDUP_MS = 5000
const recentCrashAt = new Map<string, number>()

function logRuntimeError(error: unknown): void {
  console.error('[runtime]', error)
  const dedupKey = errMessage(error).slice(0, 500)
  const now = Date.now()
  const last = recentCrashAt.get(dedupKey)
  if (last != null && now - last < CRASH_LOG_DEDUP_MS) return
  for (const [k, t] of recentCrashAt) {
    if (now - t >= CRASH_LOG_DEDUP_MS) recentCrashAt.delete(k)
  }
  recentCrashAt.set(dedupKey, now)
  try {
    const storage: StorageLike | null =
      typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
    recordCrash(storage, {
      at: Date.now(),
      message: errMessage(error),
      stack: (error as { stack?: string } | null | undefined)?.stack
    })
  } catch {
    // 静默：不能因为写日志失败导致二次崩溃
  }
}

/** 启动期崩溃才换屏；挂载后只记日志，交给 ErrorBoundary / 各页面自己的错误位。 */
function handleGlobalError(error: unknown, event: Event): void {
  if (isBenignError(error)) {
    event.preventDefault?.()
    return
  }
  if (appMounted) {
    logRuntimeError(error)
    event.preventDefault?.()
    return
  }
  showCrashScreen(error)
}

// 捕获全局未处理的同步 JS 异常
window.addEventListener('error', (event) => {
  // 良性警告（如 ResizeObserver loop）直接吞掉。
  // 注意：浏览器对这类 warning 仍会派发 error 事件，但 event.error 可能为空。
  if (isBenignError(event.message)) {
    event.preventDefault?.()
    return
  }
  handleGlobalError(event.error || new Error(event.message), event)
})

// 捕获未处理的 Promise 拒绝事件
window.addEventListener('unhandledrejection', (event) => {
  handleGlobalError(event.reason || new Error('Unhandled Promise Rejection'), event)
})

function showCrashScreen(error: unknown) {
  const err = error as ThrownValue
  const name = (typeof err === 'object' && err?.name) || 'Error'
  const stack = (typeof err === 'object' && err?.stack) || '无堆栈信息'
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML = `
      <div style="padding: 24px; color: #ff4d4d; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #121214; min-height: 100vh; box-sizing: border-box; line-height: 1.5;">
        <h2 style="margin-top: 0; font-size: 20px; border-bottom: 1px solid #2e2e33; padding-bottom: 12px; color: #ff6b6b;">
          ⚠️ 渲染进程启动失败 (Renderer Crash)
        </h2>
        <p style="font-weight: bold; font-size: 15px; margin: 16px 0 8px;">
          ${name}: ${errMessage(error)}
        </p>
        <pre style="background: #1e1e22; padding: 16px; border-radius: 6px; overflow: auto; max-height: 60vh; white-space: pre-wrap; font-size: 12px; color: #c9d1d9; border: 1px solid #2e2e33;">${stack}</pre>
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
  appMounted = true
} catch (error) {
  showCrashScreen(error)
}
