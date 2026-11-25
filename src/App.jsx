import { useEffect, useState, useCallback } from 'react'
import { Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react'
import { supabase } from './lib/supabase'
import AuthView from './components/AuthView'
import Navbar from './components/Navbar'
import OutreachGoalPanel from './components/OutreachGoalPanel'
import ExecutionPanel from './components/ExecutionPanel'
import AuditHistoryTab from './components/AuditHistoryTab'
import ToastContainer from './components/ToastContainer'
import {
  runPlanAndDraftAgent,
  approveAndSendEmail,
  rejectAgentDraft,
} from './services/agentWorkflow'

export default function App() {
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('workspace')

  // Left panel state
  const [recipientEmail, setRecipientEmail] = useState('')
  const [goal, setGoal] = useState('')
  const [tone, setTone] = useState('Semi-Formal')
  const [isPlanning, setIsPlanning] = useState(false)

  // Right panel state
  const [activeRun, setActiveRun] = useState(null)
  const [draftRecipient, setDraftRecipient] = useState('')
  const [draftSubject, setDraftSubject] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isRejecting, setIsRejecting] = useState(false)

  // Banner & Toasts
  const [banner, setBanner] = useState(null)
  const [toasts, setToasts] = useState([])

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const addToast = useCallback(
    ({ type = 'info', title, message }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setToasts((prev) => [...prev, { id, type, title, message }])
      setTimeout(() => {
        dismissToast(id)
      }, 5500)
    },
    [dismissToast]
  )

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return
      if (error) {
        addToast({
          type: 'error',
          title: 'Session error',
          message: error.message,
        })
      }
      setSession(data?.session ?? null)
      setAuthLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return
      setSession(nextSession)
      setAuthLoading(false)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [addToast])

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) {
      addToast({
        type: 'error',
        title: 'Sign out failed',
        message: error.message,
      })
      return
    }
    setActiveRun(null)
    setBanner(null)
    setActiveTab('workspace')
    addToast({
      type: 'info',
      title: 'Signed out',
      message: 'Your MailPilot session has ended.',
    })
  }

  const syncDraftFields = (run) => {
    setDraftRecipient(run?.draft_payload?.recipientEmail || '')
    setDraftSubject(run?.draft_payload?.subject || '')
    setDraftBody(run?.draft_payload?.body || '')
  }

  const handlePlanAndDraft = async () => {
    if (!session?.user) return
    setBanner(null)
    setIsPlanning(true)

    try {
      const createdRun = await runPlanAndDraftAgent({
        user: session.user,
        recipientEmail,
        goal,
        tone,
        onProgress: (partialRun) => {
          setActiveRun((prev) => ({
            ...(prev && !prev.id ? prev : {}),
            ...partialRun,
          }))
        },
      })

      setActiveRun(createdRun)
      syncDraftFields(createdRun)

      addToast({
        type: 'info',
        title: 'Draft Ready for Approval',
        message: `Risk: ${createdRun.draft_payload?.riskLevel}. Review and approve before sending.`,
      })
    } catch (err) {
      setBanner({
        type: 'error',
        message: err.message || 'Agent planning failed.',
      })
      addToast({
        type: 'error',
        title: 'Agent Workflow Error',
        message: err.message || 'Could not plan & draft email.',
      })
    } finally {
      setIsPlanning(false)
    }
  }

  const handleApproveAndSend = async () => {
    if (!session?.user || !activeRun) return
    setBanner(null)
    setIsSending(true)

    try {
      const { updatedRun, messageId } = await approveAndSendEmail({
        run: activeRun,
        user: session.user,
        recipientEmail: draftRecipient,
        subject: draftSubject,
        body: draftBody,
      })

      setActiveRun(updatedRun)
      syncDraftFields(updatedRun)

      const confirmationMsg = messageId
        ? `Email sent to ${draftRecipient.trim()} (Brevo ID: ${messageId}).`
        : `Email sent to ${draftRecipient.trim()} and logged to Supabase.`

      setBanner({
        type: 'success',
        message: confirmationMsg,
      })
      addToast({
        type: 'success',
        title: 'Email Dispatched',
        message: confirmationMsg,
      })
    } catch (err) {
      if (err.updatedTrace || err.updatedDraftPayload) {
        setActiveRun((prev) =>
          prev
            ? {
                ...prev,
                trace: err.updatedTrace || prev.trace,
                draft_payload: err.updatedDraftPayload || prev.draft_payload,
              }
            : prev
        )
      }
      setBanner({
        type: 'error',
        message: err.message || 'Failed to send email via Brevo.',
      })
      addToast({
        type: 'error',
        title: 'Dispatch Failed',
        message: err.message || 'Failed to send email.',
      })
    } finally {
      setIsSending(false)
    }
  }

  const handleRejectDraft = async () => {
    if (!session?.user || !activeRun) return
    setBanner(null)
    setIsRejecting(true)

    try {
      const updatedRun = await rejectAgentDraft({
        run: activeRun,
        user: session.user,
        draftPayload: {
          ...(activeRun.draft_payload || {}),
          recipientEmail: draftRecipient,
          subject: draftSubject,
          body: draftBody,
        },
      })

      setActiveRun(updatedRun)
      addToast({
        type: 'warning',
        title: 'Draft Rejected',
        message: 'Agent run marked as rejected. No email was sent.',
      })
    } catch (err) {
      setBanner({
        type: 'error',
        message: err.message || 'Could not reject draft.',
      })
      addToast({
        type: 'error',
        title: 'Reject Failed',
        message: err.message,
      })
    } finally {
      setIsRejecting(false)
    }
  }

  const handleOpenRunInWorkspace = (run) => {
    setActiveRun(run)
    syncDraftFields(run)
    setRecipientEmail(run?.draft_payload?.recipientEmail || '')
    setGoal(run?.goal || '')
    setTone(run?.draft_payload?.tone || 'Semi-Formal')
    setActiveTab('workspace')
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-300 gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
        <span className="text-sm font-medium">Initializing MailPilot...</span>
      </div>
    )
  }

  if (!session) {
    return (
      <>
        <AuthView addToast={addToast} />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Subtle top ambient gradient */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-80 bg-gradient-to-b from-indigo-950/30 via-slate-950/0 to-transparent" />

      <Navbar
        user={session.user}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onSignOut={handleSignOut}
      />

      <main className="relative z-10 flex-1 mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 space-y-5">
        {banner && (
          <div
            className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs font-medium ${
              banner.type === 'success'
                ? 'border-emerald-500/40 bg-emerald-950/50 text-emerald-200'
                : 'border-rose-500/40 bg-rose-950/50 text-rose-200'
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {banner.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
              )}
              <span className="break-words">{banner.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="rounded-lg p-1 opacity-75 hover:opacity-100 hover:bg-white/10"
              aria-label="Close banner"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {activeTab === 'workspace' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-5">
              <OutreachGoalPanel
                userEmail={session.user.email}
                recipientEmail={recipientEmail}
                setRecipientEmail={setRecipientEmail}
                goal={goal}
                setGoal={setGoal}
                tone={tone}
                setTone={setTone}
                isPlanning={isPlanning}
                onPlanAndDraft={handlePlanAndDraft}
              />
            </div>

            <div className="lg:col-span-7">
              <ExecutionPanel
                userEmail={session.user.email}
                activeRun={activeRun}
                draftRecipient={draftRecipient}
                setDraftRecipient={setDraftRecipient}
                draftSubject={draftSubject}
                setDraftSubject={setDraftSubject}
                draftBody={draftBody}
                setDraftBody={setDraftBody}
                isSending={isSending}
                isRejecting={isRejecting}
                onApproveAndSend={handleApproveAndSend}
                onRejectDraft={handleRejectDraft}
              />
            </div>
          </div>
        ) : (
          <AuditHistoryTab
            user={session.user}
            onOpenRunInWorkspace={handleOpenRunInWorkspace}
            addToast={addToast}
          />
        )}
      </main>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
