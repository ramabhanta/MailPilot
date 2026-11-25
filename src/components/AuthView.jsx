import { useState } from 'react'
import {
  Send,
  Lock,
  Mail,
  KeyRound,
  Sparkles,
  ShieldCheck,
  Loader2,
  User,
  ArrowLeft,
} from 'lucide-react'
import { supabase } from '../lib/supabase'

export default function AuthView({ addToast }) {
  const [authMethod, setAuthMethod] = useState('password') // 'password' | 'otp'
  const [passwordMode, setPasswordMode] = useState('signin') // 'signin' | 'signup'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')

  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState('')

  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [infoMsg, setInfoMsg] = useState('')

  const resetMessages = () => {
    setErrorMsg('')
    setInfoMsg('')
  }

  const handlePasswordSubmit = async (e) => {
    e.preventDefault()
    resetMessages()

    if (!email.trim() || !password) {
      setErrorMsg('Please enter both your email and password.')
      return
    }

    setLoading(true)
    try {
      if (passwordMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (error) throw error
        addToast({
          type: 'success',
          title: 'Signed in to MailPilot',
          message: `Welcome back, ${email.trim()}`,
        })
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              full_name: fullName.trim() || undefined,
            },
          },
        })
        if (error) throw error

        if (data?.session) {
          addToast({
            type: 'success',
            title: 'Account created',
            message: 'You are now signed in to MailPilot.',
          })
        } else {
          setInfoMsg(
            'Account created! Please check your email inbox to confirm your address before signing in.'
          )
          addToast({
            type: 'info',
            title: 'Confirmation required',
            message: 'Check your email to confirm your new account.',
          })
        }
      }
    } catch (err) {
      setErrorMsg(err.message || 'Authentication failed.')
      addToast({
        type: 'error',
        title: 'Authentication error',
        message: err.message,
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSendOtp = async (e) => {
    e.preventDefault()
    resetMessages()

    if (!email.trim()) {
      setErrorMsg('Please enter your email address.')
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
      })
      if (error) throw error

      setOtpSent(true)
      setInfoMsg(`A 6-digit verification code has been sent to ${email.trim()}.`)
      addToast({
        type: 'success',
        title: 'OTP Sent',
        message: `Check ${email.trim()} for your 6-digit login code.`,
      })
    } catch (err) {
      setErrorMsg(err.message || 'Failed to send OTP.')
      addToast({
        type: 'error',
        title: 'Could not send OTP',
        message: err.message,
      })
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOtp = async (e) => {
    e.preventDefault()
    resetMessages()

    const cleanToken = otpCode.replace(/\s+/g, '')
    if (!cleanToken || cleanToken.length < 6) {
      setErrorMsg('Please enter the 6-digit OTP code from your email.')
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: cleanToken,
        type: 'email',
      })
      if (error) throw error

      addToast({
        type: 'success',
        title: 'OTP Verified',
        message: `Signed in as ${email.trim()}`,
      })
    } catch (err) {
      setErrorMsg(err.message || 'Invalid or expired OTP code.')
      addToast({
        type: 'error',
        title: 'OTP verification failed',
        message: err.message,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 relative flex items-center justify-center p-4 overflow-hidden">
      {/* Subtle radial glow backdrop */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 h-96 w-[44rem] rounded-full bg-indigo-600/20 blur-3xl" />
        <div className="absolute -bottom-32 right-1/4 h-72 w-72 rounded-full bg-violet-600/10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Brand header */}
        <div className="text-center mb-7">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/30 mb-4">
            <Send className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            MailPilot
          </h1>
          <p className="text-sm text-slate-400 mt-1 flex items-center justify-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            Autonomous AI Email Outreach Agent
          </p>
        </div>

        {/* Auth Card */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/85 backdrop-blur-xl shadow-2xl p-6 sm:p-7">
          {/* Primary Auth Method Tabs */}
          <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-slate-950/80 p-1 border border-slate-800/80 mb-6">
            <button
              type="button"
              onClick={() => {
                setAuthMethod('password')
                resetMessages()
              }}
              className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-medium transition-all ${
                authMethod === 'password'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Lock className="h-3.5 w-3.5" />
              Email & Password
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMethod('otp')
                resetMessages()
              }}
              className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-medium transition-all ${
                authMethod === 'otp'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              6-Digit Email OTP
            </button>
          </div>

          {errorMsg && (
            <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-950/50 px-3.5 py-2.5 text-xs text-rose-200">
              {errorMsg}
            </div>
          )}

          {infoMsg && (
            <div className="mb-4 rounded-xl border border-indigo-500/40 bg-indigo-950/50 px-3.5 py-2.5 text-xs text-indigo-200">
              {infoMsg}
            </div>
          )}

          {authMethod === 'password' ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              {passwordMode === 'signup' && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Full Name <span className="text-slate-500">(optional)</span>
                  </label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Alex Mercer"
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/80 pl-9 pr-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/80 pl-9 pr-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/80 pl-9 pr-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-all"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {passwordMode === 'signin' ? 'Sign In' : 'Create Account'}
              </button>

              <div className="pt-2 text-center text-xs text-slate-400">
                {passwordMode === 'signin' ? (
                  <>
                    Don&apos;t have an account?{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setPasswordMode('signup')
                        resetMessages()
                      }}
                      className="text-indigo-400 hover:text-indigo-300 font-medium"
                    >
                      Sign Up
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setPasswordMode('signin')
                        resetMessages()
                      }}
                      className="text-indigo-400 hover:text-indigo-300 font-medium"
                    >
                      Sign In
                    </button>
                  </>
                )}
              </div>
            </form>
          ) : !otpSent ? (
            <form onSubmit={handleSendOtp} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/80 pl-9 pr-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
                <p className="text-[11px] text-slate-500 mt-1.5">
                  We&apos;ll email you a one-time 6-digit verification code.
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-all"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Send OTP
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div className="flex items-center justify-between text-xs text-slate-400 bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2">
                <span className="truncate">{email}</span>
                <button
                  type="button"
                  onClick={() => {
                    setOtpSent(false)
                    setOtpCode('')
                    resetMessages()
                  }}
                  className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 shrink-0 ml-2 font-medium"
                >
                  <ArrowLeft className="h-3 w-3" />
                  Change
                </button>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  6-Digit Verification Code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-3 text-center font-mono text-lg tracking-[0.45em] text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-all"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Verify OTP
              </button>

              <button
                type="button"
                disabled={loading}
                onClick={handleSendOtp}
                className="w-full text-center text-xs text-slate-400 hover:text-indigo-300 transition-colors"
              >
                Resend 6-digit code
              </button>
            </form>
          )}
        </div>

        <p className="mt-5 text-center text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-500/80" />
          Human-in-the-Loop protected outreach • Powered by Gemini & Brevo
        </p>
      </div>
    </div>
  )
}
