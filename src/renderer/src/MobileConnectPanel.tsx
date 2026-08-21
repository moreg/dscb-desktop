import { useEffect, useState } from 'react'
import type { MobileServerStatus } from '../../shared/types'

const STOPPED: MobileServerStatus = {
  running: false,
  addressUrls: [],
  pairingUrl: null,
  qrDataUrl: null,
  pairingAvailable: false,
  pairedDevices: 0,
  accessibleOnLan: false
}

export default function MobileConnectPanel() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<MobileServerStatus>(STOPPED)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const refresh = async () => {
    try {
      setStatus(await window.api.getMobileServerStatus())
      setError('')
    } catch (err) {
      setError((err as Error).message || '无法读取手机连接状态')
    }
  }

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const run = async (action: () => Promise<MobileServerStatus>) => {
    setBusy(true)
    setError('')
    try {
      setStatus(await action())
    } catch (err) {
      setError((err as Error).message || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const copyAddress = async () => {
    const value = status.pairingUrl || status.addressUrls[0]
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('复制失败，请手动输入二维码下方的地址')
    }
  }

  return (
    <>
      <button className="nav-item" onClick={() => setOpen(true)}>
        <span className="icon">▣</span>
        手机连接
        {status.running ? <span className="mobile-live-dot" title="手机服务已开启" /> : null}
      </button>

      {open ? (
        <div className="mobile-connect-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="mobile-connect-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-connect-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="mobile-connect-head">
              <div>
                <h2 id="mobile-connect-title">手机连接</h2>
                <p>扫码后，在手机浏览器中编辑电脑上的作品</p>
              </div>
              <button className="mobile-connect-close" onClick={() => setOpen(false)} aria-label="关闭">
                ×
              </button>
            </header>

            {error ? <div className="mobile-connect-error">{error}</div> : null}

            {!status.running ? (
              <div className="mobile-connect-start">
                <div className="mobile-phone-mark" aria-hidden="true">▯</div>
                <h3>连接手机继续创作</h3>
                <p>请确保手机和电脑连接同一个 Wi‑Fi。服务只在你主动开启后运行。</p>
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void run(() => window.api.startMobileServer())}
                >
                  {busy ? '正在开启…' : '开启并生成二维码'}
                </button>
              </div>
            ) : (
              <div className="mobile-connect-running">
                <div className="mobile-connect-statusline">
                  <span className="mobile-status-ok">● 服务已开启</span>
                  <span>{status.pairedDevices} 台手机已连接</span>
                </div>

                {!status.accessibleOnLan ? (
                  <div className="mobile-connect-warning">
                    没有检测到局域网地址。请确认电脑已连接 Wi‑Fi 或网线后，生成新二维码。
                  </div>
                ) : status.pairingAvailable && status.qrDataUrl ? (
                  <div className="mobile-qr-area">
                    <img src={status.qrDataUrl} alt="手机连接二维码" className="mobile-qr" />
                    <strong>使用手机相机扫码</strong>
                    <span>二维码配对成功一次后立即失效</span>
                  </div>
                ) : (
                  <div className="mobile-paired-card">
                    <span className="mobile-paired-icon">✓</span>
                    <strong>手机已连接</strong>
                    <p>现在可以在手机上选择项目、打开章节并编辑正文。</p>
                  </div>
                )}

                {status.pairingUrl ? (
                  <button className="mobile-address" onClick={() => void copyAddress()} title="复制连接地址">
                    <span>{status.pairingUrl}</span>
                    <b>{copied ? '已复制' : '复制'}</b>
                  </button>
                ) : null}

                <div className="mobile-connect-notes">
                  <p>电脑应用需要保持运行；正文仍保存在电脑本地。</p>
                  <p>如果 Windows 弹出网络访问提示，请仅允许“专用网络”。</p>
                </div>

                <footer className="mobile-connect-actions">
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void run(() => window.api.refreshMobilePairing())}
                  >
                    生成新二维码
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => void run(() => window.api.stopMobileServer())}
                  >
                    关闭手机连接
                  </button>
                </footer>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </>
  )
}
