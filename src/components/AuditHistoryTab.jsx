import { useEffect, useState, useCallback } from 'react'
import {
  RefreshCw,
  Bot,
  MailCheck,
  Clock,
  Loader2,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  AlertCircle,
} from 'lucide-react'
import { supabase } from '../lib/supabase'

const STATUS_PILLS = {
  awaiting_approval: 'border-amber-500/35 bg-amber-500/10 text-amber-300',
  completed: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300',
  sent: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300',
  rejected: 'border-rose-500/35 bg-rose-500/10 text-rose-300',
  failed: 'border-rose-500/35 bg-rose-500/10 text-rose-300',
  running: 'border-indigo-500/35 bg-indigo-500/10 text-indigo-300',
}

export default function AuditHistoryTab({ user, onOpenRunInWorkspace, addToast }) {
  const [agentRuns, setAgentRuns] = useState([])
  const [emailLogs, setEmailLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [expandedRunId, setExpandedRunId] = useState(null)
  const [expandedLogId, setExpandedLogId] = useState(null)

  const fetchHistory = useCallback(async () => {
    setLoading(true)
    setErrorMsg('')
    try {
      const [runsRes, logsRes] = await Promise.all([
        supabase
          .from('agent_runs')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('email_logs')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(50),
      ])

      if (runsRes.error) throw runsRes.error
      if (logsRes.error) throw logsRes.error

      setAgentRuns(runsRes.data || [])
      setEmailLogs(logsRes.data || [])
    } catch (err) {
      setErrorMsg(err.message || 'Failed to load audit history.')
      addToast({
        type: 'error',
        title: 'Audit History Error',
        message: err.message,
      })
    } finally {
      setLoading(false)
    }
  }, [user.id, addToast])

  useEffect(() => {
    fetchHistory()
  }, [fetchHistory])

  const formatTimestamp = (iso) => {
    if (!iso) return '—'
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  }

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Audit History &amp; Execution Logs
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Immutable trail of your AI agent runs and dispatched Brevo emails.
          </p>
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={fetchHistory}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 hover:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 transition-all disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-950/50 p-4 text-xs text-rose-200 flex items-start gap-2.5">
          <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Could not query Supabase tables</p>
            <p className="opacity-90 mt-0.5">{errorMsg}</p>
            <p className="opacity-75 mt-1">
              Make sure <code className="font-mono">agent_runs</code> and{' '}
              <code className="font-mono">email_logs</code> tables exist (see{' '}
              <code className="font-mono">supabase/schema.sql</code>).
            </p>
          </div>
        </div>
      )}

      {loading && agentRuns.length === 0 && emailLogs.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-slate-400 gap-2.5 text-sm">
          <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
          Loading audit history...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Past Agent Runs */}
          <section className="rounded-2xl border border-slate-800/90 bg-slate-900/75 backdrop-blur-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-white">
                  Agent Runs
                </h3>
              </div>
              <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] font-mono text-slate-300">
                {agentRuns.length}
              </span>
            </div>

            {agentRuns.length === 0 ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                No agent runs recorded yet. Create an outreach goal in the Agent Workspace.
              </p>
            ) : (
              <div className="space-y-3">
                {agentRuns.map((run) => {
                  const isExpanded = expandedRunId === run.id
                  const recipient = run.draft_payload?.recipientEmail || '—'
                  const risk = run.draft_payload?.riskLevel

                  return (
                    <div
                      key={run.id}
                      className="rounded-xl border border-slate-800 bg-slate-950/75 overflow-hidden"
                    >
                      <div className="p-3.5 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-100 truncate">
                              To: {recipient}
                            </p>
                            <p className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">
                              {run.goal}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              STATUS_PILLS[run.status] || STATUS_PILLS.running
                            }`}
                          >
                            {run.status}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatTimestamp(run.created_at)}
                          </span>

                          <div className="flex items-center gap-2">
                            {risk && (
                              <span className="font-mono text-[10px] text-slate-400">
                                {risk}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => onOpenRunInWorkspace(run)}
                              className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 font-medium"
                            >
                              Open
                              <ArrowUpRight className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedRunId(isExpanded ? null : run.id)
                              }
                              className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-200"
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                              Trace
                            </button>
                          </div>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-slate-800/80 bg-slate-950 p-3 text-[11px] space-y-2">
                          <div className="text-slate-400 font-medium">
                            Subject:{' '}
                            <span className="text-slate-200">
                              {run.draft_payload?.subject || '—'}
                            </span>
                          </div>
                          <pre className="font-mono text-[10px] text-slate-300 bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                            {JSON.stringify(run.trace || [], null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* Past Email Dispatch Logs */}
          <section className="rounded-2xl border border-slate-800/90 bg-slate-900/75 backdrop-blur-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
              <div className="flex items-center gap-2">
                <MailCheck className="h-4 w-4 text-emerald-400" />
                <h3 className="text-sm font-semibold text-white">
                  Email Dispatch Logs
                </h3>
              </div>
              <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] font-mono text-slate-300">
                {emailLogs.length}
              </span>
            </div>

            {emailLogs.length === 0 ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                No dispatched emails logged yet. Approve a draft to send via Brevo.
              </p>
            ) : (
              <div className="space-y-3">
                {emailLogs.map((log) => {
                  const isExpanded = expandedLogId === log.id
                  return (
                    <div
                      key={log.id}
                      className="rounded-xl border border-slate-800 bg-slate-950/75 overflow-hidden"
                    >
                      <div className="p-3.5 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-100 truncate">
                              {log.subject}
                            </p>
                            <p className="text-[11px] text-slate-400 truncate mt-0.5">
                              To: {log.recipient_email}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              STATUS_PILLS[log.status] || STATUS_PILLS.sent
                            }`}
                          >
                            {log.status}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatTimestamp(log.created_at)}
                          </span>

                          <div className="flex items-center gap-2">
                            {log.risk_level && (
                              <span className="font-mono text-[10px] text-slate-400">
                                {log.risk_level}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedLogId(isExpanded ? null : log.id)
                              }
                              className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-200"
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                              Details
                            </button>
                          </div>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-slate-800/80 bg-slate-950 p-3 text-[11px] space-y-2">
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
                            <span>
                              Reply-To:{' '}
                              <span className="text-slate-200">
                                {log.sender_email}
                              </span>
                            </span>
                            {log.provider_message_id && (
                              <span className="font-mono">
                                Brevo ID: {log.provider_message_id}
                              </span>
                            )}
                          </div>
                          <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5 text-xs text-slate-300 whitespace-pre-wrap leading-relaxed max-h-48 overflow-auto">
                            {log.body}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
