import { useState } from 'react'
import {
  Bot,
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  Loader2,
  Send,
  Ban,
  ChevronDown,
  ChevronRight,
  Terminal,
  ShieldCheck,
  ShieldAlert,
  Edit3,
} from 'lucide-react'

const STEP_BADGE = {
  done: {
    label: 'done',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />,
  },
  awaiting_approval: {
    label: 'awaiting_approval',
    className: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
    icon: <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />,
  },
  pending: {
    label: 'pending',
    className: 'border-slate-700 bg-slate-800/70 text-slate-400',
    icon: <Clock className="h-3.5 w-3.5 text-slate-500" />,
  },
  failed: {
    label: 'failed',
    className: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
    icon: <XCircle className="h-3.5 w-3.5 text-rose-400" />,
  },
}

const RUN_STATUS_PILL = {
  running: 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300',
  awaiting_approval: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  completed: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  rejected: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  failed: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
}

export default function ExecutionPanel({
  activeRun,
  draftRecipient,
  setDraftRecipient,
  draftSubject,
  setDraftSubject,
  draftBody,
  setDraftBody,
  isSending,
  isRejecting,
  onApproveAndSend,
  onRejectDraft,
}) {
  const [traceOpen, setTraceOpen] = useState(false)

  if (!activeRun) {
    return (
      <section className="rounded-2xl border border-slate-800/90 bg-slate-900/60 backdrop-blur-xl shadow-xl p-6 sm:p-8 flex flex-col items-center justify-center text-center min-h-[460px]">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/90 text-indigo-400 mb-4 shadow-inner">
          <Bot className="h-7 w-7" />
        </div>
        <h2 className="text-base font-semibold text-white">
          Agent Execution Plan, Trace &amp; Approval Gate
        </h2>
        <p className="text-xs text-slate-400 max-w-md mt-2 leading-relaxed">
          Submit an outreach goal on the left to watch MailPilot validate the
          recipient, classify risk, generate a 5-step execution plan via Gemini,
          and stage the draft here for your human-in-the-loop approval.
        </p>
      </section>
    )
  }

  const plan = Array.isArray(activeRun.plan) ? activeRun.plan : []
  const trace = Array.isArray(activeRun.trace) ? activeRun.trace : []
  const riskLevel = activeRun.draft_payload?.riskLevel || 'HIGH'
  const isAwaitingApproval = activeRun.status === 'awaiting_approval'
  const isBusy = isSending || isRejecting

  return (
    <section className="rounded-2xl border border-slate-800/90 bg-slate-900/75 backdrop-blur-xl shadow-xl p-5 sm:p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-white leading-tight">
              Agent Execution Plan, Trace &amp; Approval Gate
            </h2>
            {activeRun.id && (
              <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                Run ID: {activeRun.id}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
              riskLevel === 'HIGH'
                ? 'border-rose-500/35 bg-rose-500/10 text-rose-300'
                : 'border-amber-500/35 bg-amber-500/10 text-amber-300'
            }`}
          >
            {riskLevel === 'HIGH' ? (
              <ShieldAlert className="h-3 w-3" />
            ) : (
              <ShieldCheck className="h-3 w-3" />
            )}
            {riskLevel} RISK
          </span>

          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
              RUN_STATUS_PILL[activeRun.status] || RUN_STATUS_PILL.running
            }`}
          >
            {activeRun.status === 'running' && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {activeRun.status}
          </span>
        </div>
      </div>

      {/* 5-Step Agent Plan */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          5-Step Agent Execution Plan
        </h3>
        <div className="space-y-2.5">
          {plan.map((item, idx) => {
            const badge = STEP_BADGE[item.status] || STEP_BADGE.pending
            return (
              <div
                key={item.step || idx}
                className={`rounded-xl border p-3 transition-all ${
                  item.status === 'awaiting_approval'
                    ? 'border-amber-500/40 bg-amber-950/20'
                    : item.status === 'failed'
                    ? 'border-rose-500/35 bg-rose-950/20'
                    : item.status === 'done'
                    ? 'border-slate-800 bg-slate-950/70'
                    : 'border-slate-800/60 bg-slate-950/40 opacity-75'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[11px] font-semibold text-slate-300">
                      {item.step || idx + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-100">
                        {item.title}
                      </p>
                      <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono font-medium ${badge.className}`}
                  >
                    {badge.icon}
                    {badge.label}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Editable Draft Review Card */}
      {activeRun.draft_payload && (
        <div className="rounded-xl border border-indigo-500/25 bg-slate-950/80 p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Edit3 className="h-4 w-4 text-indigo-400" />
              <h3 className="text-sm font-semibold text-white">
                {isAwaitingApproval
                  ? 'Human-in-the-Loop Draft Review'
                  : 'Email Draft Snapshot'}
              </h3>
            </div>
            {isAwaitingApproval && (
              <span className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-0.5">
                Editable before dispatch
              </span>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-400 mb-1">
                Recipient
              </label>
              <input
                type="email"
                disabled={!isAwaitingApproval || isBusy}
                value={draftRecipient}
                onChange={(e) => setDraftRecipient(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-75"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-400 mb-1">
                Subject
              </label>
              <input
                type="text"
                disabled={!isAwaitingApproval || isBusy}
                value={draftSubject}
                onChange={(e) => setDraftSubject(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-2 text-xs font-medium text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-75"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-400 mb-1">
                Email Body
              </label>
              <textarea
                rows={8}
                disabled={!isAwaitingApproval || isBusy}
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-2.5 text-xs leading-relaxed text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-75 resize-y"
              />
            </div>
          </div>

          {isAwaitingApproval && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={onApproveAndSend}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-emerald-600/20 transition-all"
              >
                {isSending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Dispatching via Brevo...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    Approve &amp; Send Email
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={isBusy}
                onClick={onRejectDraft}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-950/40 hover:bg-rose-900/50 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2.5 text-xs font-semibold text-rose-200 transition-all"
              >
                {isRejecting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Rejecting...
                  </>
                ) : (
                  <>
                    <Ban className="h-4 w-4" />
                    Reject Draft
                  </>
                )}
              </button>
            </div>
          )}

          {activeRun.status === 'completed' && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              Email approved, sent via Brevo, and recorded in your Supabase audit log.
            </div>
          )}

          {activeRun.status === 'rejected' && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200 flex items-center gap-2">
              <Ban className="h-4 w-4 text-rose-400 shrink-0" />
              Draft rejected at the Human-in-the-Loop approval gate. No email was sent.
            </div>
          )}
        </div>
      )}

      {/* Collapsible Agent Tool Trace */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/70 overflow-hidden">
        <button
          type="button"
          onClick={() => setTraceOpen((prev) => !prev)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-900/60 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-indigo-400" />
            <span className="text-xs font-semibold text-slate-200">
              Agent Tool Trace
            </span>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-400">
              {trace.length} events
            </span>
          </div>
          {traceOpen ? (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400" />
          )}
        </button>

        {traceOpen && (
          <div className="border-t border-slate-800/80 p-4 space-y-3">
            {trace.length === 0 ? (
              <p className="text-xs text-slate-500">No tool events recorded yet.</p>
            ) : (
              trace.map((entry, idx) => (
                <div
                  key={entry.id || idx}
                  className="relative pl-5 border-l border-slate-800 space-y-1.5"
                >
                  <span
                    className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-slate-950 ${
                      entry.status === 'error'
                        ? 'bg-rose-400'
                        : entry.status === 'awaiting'
                        ? 'bg-amber-400'
                        : 'bg-emerald-400'
                    }`}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-indigo-300">
                      {entry.tool}
                    </span>
                    <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                      <span className="rounded bg-slate-900 border border-slate-800 px-1.5 py-0.5">
                        {entry.durationMs ?? 0} ms
                      </span>
                      <span>
                        {entry.timestamp
                          ? new Date(entry.timestamp).toLocaleTimeString()
                          : ''}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded-lg bg-slate-900/80 border border-slate-800/80 p-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                        Inputs
                      </div>
                      <pre className="font-mono text-[10px] text-slate-300 whitespace-pre-wrap break-words max-h-36 overflow-auto">
                        {JSON.stringify(entry.inputs, null, 2)}
                      </pre>
                    </div>
                    <div className="rounded-lg bg-slate-900/80 border border-slate-800/80 p-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                        Outputs
                      </div>
                      <pre className="font-mono text-[10px] text-slate-300 whitespace-pre-wrap break-words max-h-36 overflow-auto">
                        {JSON.stringify(entry.outputs, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  )
}
