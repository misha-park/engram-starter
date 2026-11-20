import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { clearToast, currentToast, subscribeToast, toast } from './toastStore'
import s from './Toast.module.css'

export function ToastHost() {
  const t = useSyncExternalStore(subscribeToast, currentToast)
  useEffect(() => {
    if (!t) return
    const timer = setTimeout(() => clearToast(t.id), t.ms)
    return () => clearTimeout(timer)
  }, [t])
  if (!t) return null
  return createPortal(
    <div className={s.toast} data-tone={t.tone} role={t.tone === 'error' ? 'alert' : 'status'}>
      <span className={s.text}>{t.text}</span>
      {t.action && (
        <button
          className={s.action}
          onClick={async () => {
            clearToast()
            try {
              await t.action!.run()
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
            }
          }}
        >
          {t.action.label}
        </button>
      )}
      <button className={s.close} aria-label="Dismiss" onClick={() => clearToast()}>
        <X size={13} />
      </button>
    </div>,
    document.body
  )
}
