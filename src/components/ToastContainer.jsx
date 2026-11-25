import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react'

const STYLES = {
  success: {
    container: 'bg-emerald-950/90 border-emerald-500/40 text-emerald-100',
    icon: <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />,
  },
  error: {
    container: 'bg-rose-950/90 border-rose-500/40 text-rose-100',
    icon: <XCircle className="h-5 w-5 text-rose-400 shrink-0" />,
  },
  warning: {
    container: 'bg-amber-950/90 border-amber-500/40 text-amber-100',
    icon: <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />,
  },
  info: {
    container: 'bg-indigo-950/90 border-indigo-500/40 text-indigo-100',
    icon: <Info className="h-5 w-5 text-indigo-400 shrink-0" />,
  },
}

export default function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2.5 max-w-md w-full px-4 sm:px-0 pointer-events-none">
      {toasts.map((toast) => {
        const style = STYLES[toast.type] || STYLES.info
        return (
          <div
            key={toast.id}
            role="alert"
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border p-3.5 shadow-2xl backdrop-blur-md transition-all ${style.container}`}
          >
            {style.icon}
            <div className="flex-1 min-w-0">
              {toast.title && (
                <p className="text-sm font-semibold leading-tight">{toast.title}</p>
              )}
              {toast.message && (
                <p className="text-xs opacity-90 mt-0.5 break-words">{toast.message}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="rounded-lg p-1 opacity-70 hover:opacity-100 hover:bg-white/10 transition-colors"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
