import {
  Sparkles,
  Mail,
  Target,
  MessageSquare,
  Loader2,
  ShieldAlert,
  UserCheck,
} from 'lucide-react'

const TONES = [
  {
    value: 'Formal',
    label: 'Formal',
    desc: 'Executive & structured',
  },
  {
    value: 'Semi-Formal',
    label: 'Semi-Formal',
    desc: 'Polished & approachable',
  },
  {
    value: 'Friendly',
    label: 'Friendly',
    desc: 'Warm & conversational',
  },
]

export default function OutreachGoalPanel({
  userEmail,
  recipientEmail,
  setRecipientEmail,
  goal,
  setGoal,
  tone,
  setTone,
  isPlanning,
  onPlanAndDraft,
}) {
  const isSelfTest =
    recipientEmail.trim().toLowerCase() === (userEmail || '').trim().toLowerCase() &&
    recipientEmail.trim().length > 0

  const handleSubmit = (e) => {
    e.preventDefault()
    onPlanAndDraft()
  }

  return (
    <section className="rounded-2xl border border-slate-800/90 bg-slate-900/75 backdrop-blur-xl shadow-xl p-5 sm:p-6 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
              <Target className="h-4 w-4" />
            </span>
            <h2 className="text-base font-semibold text-white">
              New Outreach Goal
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1.5">
            Define your target recipient and objective. MailPilot will assess risk,
            build a 5-step execution plan, and pause for your approval.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Recipient Email */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label
              htmlFor="recipient-email"
              className="block text-xs font-medium text-slate-300"
            >
              Recipient Email
            </label>
            <button
              type="button"
              onClick={() => setRecipientEmail(userEmail || '')}
              className="text-[11px] font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Use my email (Self-Test)
            </button>
          </div>
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              id="recipient-email"
              type="email"
              required
              disabled={isPlanning}
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="prospect@company.com"
              className="w-full rounded-xl border border-slate-800 bg-slate-950/80 pl-10 pr-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60"
            />
          </div>

          {recipientEmail.trim() && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px]">
              {isSelfTest ? (
                <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                  <UserCheck className="h-3 w-3" />
                  MEDIUM Risk • Self-Test Mode
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-rose-300">
                  <ShieldAlert className="h-3 w-3" />
                  HIGH Risk • External Recipient
                </span>
              )}
            </div>
          )}
        </div>

        {/* Goal / Purpose */}
        <div>
          <label
            htmlFor="outreach-goal"
            className="block text-xs font-medium text-slate-300 mb-1.5"
          >
            Goal / Purpose
          </label>
          <textarea
            id="outreach-goal"
            rows={5}
            required
            disabled={isPlanning}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g., Introduce our AI workflow automation platform to the VP of Engineering and propose a 15-minute discovery call next Tuesday."
            className="w-full rounded-xl border border-slate-800 bg-slate-950/80 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 resize-y"
          />
        </div>

        {/* Tone Selector */}
        <div>
          <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300 mb-2">
            <MessageSquare className="h-3.5 w-3.5 text-indigo-400" />
            Tone
          </label>
          <div className="grid grid-cols-3 gap-2">
            {TONES.map((item) => {
              const selected = tone === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  disabled={isPlanning}
                  onClick={() => setTone(item.value)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-all disabled:opacity-60 ${
                    selected
                      ? 'border-indigo-500 bg-indigo-500/15 text-white shadow-sm shadow-indigo-500/15'
                      : 'border-slate-800 bg-slate-950/70 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs font-semibold">{item.label}</div>
                  <div className="text-[10px] opacity-75 mt-0.5 leading-tight">
                    {item.desc}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isPlanning}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-all"
        >
          {isPlanning ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Running Agent Planner...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Plan &amp; Draft Email
            </>
          )}
        </button>
      </form>
    </section>
  )
}
