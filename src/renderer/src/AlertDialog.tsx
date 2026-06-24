import { useEffect, useRef } from 'react'

interface AlertDialogProps {
  open: boolean
  title?: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
}

export default function AlertDialog({
  open,
  title = '提示',
  message,
  confirmLabel = '确定',
  onConfirm
}: AlertDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onConfirm()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onConfirm])

  if (!open) return null

  return (
    <div
      className="dialog-overlay"
      onClick={onConfirm}
      ref={dialogRef}
    >
      <div className="dialog" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p style={{ margin: '0 0 18px', fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)' }}>
          {message}
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
