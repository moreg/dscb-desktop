import { useEffect } from 'react'
import type { ConfirmDialogState } from '../hooks/useStyleProfileController'

interface Props {
  state: ConfirmDialogState
  onClose: () => void
}

export default function ConfirmDialog({ state, onClose }: Props) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="dialog-overlay confirm-dialog-overlay" onClick={onClose}>
      <div
        className="dialog confirm-dialog confirm-dialog-danger"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="style-profile-confirm-title"
        aria-describedby="style-profile-confirm-message"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-head">
          <div className="confirm-dialog-badge" aria-hidden="true">
            !
          </div>
          <div className="confirm-dialog-copy">
            <h3 id="style-profile-confirm-title">{state.title}</h3>
            <p id="style-profile-confirm-message">{state.message}</p>
          </div>
        </div>

        <div className="confirm-dialog-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn confirm-dialog-submit"
            onClick={() => {
              state.onConfirm()
            }}
          >
            确定删除
          </button>
        </div>
      </div>
    </div>
  )
}
