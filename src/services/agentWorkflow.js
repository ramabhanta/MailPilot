import { supabase } from '../lib/supabase'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function deriveSenderName(user) {
  if (!user) return 'MailPilot User'
  const metaName = user.user_metadata?.full_name || user.user_metadata?.name
  if (metaName && typeof metaName === 'string' && metaName.trim()) {
    return metaName.trim()
  }
  const email = user.email || ''
  const local = email.split('@')[0] || 'User'
  return local
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

export function classifyRisk(recipientEmail, senderEmail) {
  const normalizedRecipient = (recipientEmail || '').trim().toLowerCase()
  const normalizedSender = (senderEmail || '').trim().toLowerCase()

  if (!EMAIL_REGEX.test(normalizedRecipient)) {
    throw new Error('Please enter a valid recipient email address.')
  }

  const isSelfTest = normalizedRecipient === normalizedSender
  return {
    riskLevel: isSelfTest ? 'MEDIUM' : 'HIGH',
    isSelfTest,
    reason: isSelfTest
      ? 'Self-test outreach detected (recipient matches signed-in sender).'
      : 'External recipient detected; requires mandatory human approval before dispatch.',
  }
}

function buildDefaultPlan(goal, tone, riskLevel) {
  return [
    {
      step: 1,
      title: 'Validate Recipient & Classify Risk',
      description: `Verify email syntax and assign ${riskLevel} outreach risk tier.`,
      status: 'pending',
    },
    {
      step: 2,
      title: 'Synthesize Strategy & Draft via Gemini',
      description: `Generate a ${tone.toLowerCase()} email tailored to: "${goal.slice(0, 60)}${goal.length > 60 ? '...' : ''}"`,
      status: 'pending',
    },
    {
      step: 3,
      title: 'Persist Run State to Supabase',
      description: 'Checkpoint execution plan, trace, and draft payload into agent_runs.',
      status: 'pending',
    },
    {
      step: 4,
      title: 'Human-in-the-Loop Approval Gate',
      description: 'Pause execution for operator review, editing, and explicit sign-off.',
      status: 'pending',
    },
    {
      step: 5,
      title: 'Dispatch via Brevo & Log Audit Trail',
      description: 'Send email through Brevo SMTP API and record immutable email_logs audit entry.',
      status: 'pending',
    },
  ]
}

function safeParseGeminiJson(rawText) {
  if (!rawText) {
    throw new Error('Gemini returned an empty response.')
  }
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1))
    }
    throw new Error('Failed to parse structured JSON output from Gemini.')
  }
}

const GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-3.8-flash',
  'gemini-3.8-pro',
]
const GEMINI_REQUEST_TIMEOUT_MS = 60000
const GEMINI_503_RETRY_DELAY_MS = 1500

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function is503HighDemandError(err) {
  if (!err) return false
  if (err.status === 503) return true
  const msg = err.rawMessage || err.message || ''
  return /high demand|overloaded|service unavailable|\b503\b/i.test(msg)
}

function deriveRecipientGreeting(recipientEmail) {
  const local = (recipientEmail || '').split('@')[0] || ''
  const generic = new Set([
    'info',
    'hello',
    'hi',
    'contact',
    'support',
    'sales',
    'team',
    'admin',
    'noreply',
    'no-reply',
    'office',
  ])
  if (!local || generic.has(local.toLowerCase())) {
    return 'there'
  }
  const firstToken = local.split(/[._+-]+/)[0] || local
  if (!firstToken || firstToken.length < 2) return 'there'
  return firstToken.charAt(0).toUpperCase() + firstToken.slice(1).toLowerCase()
}

function buildFallbackDraftPlan({
  senderName,
  senderEmail,
  recipientEmail,
  goal,
  tone,
  riskResult,
}) {
  const greetingName = deriveRecipientGreeting(recipientEmail)
  const trimmedGoal = goal.replace(/\s+/g, ' ').trim()
  const conciseTopic =
    trimmedGoal.length > 65
      ? `${trimmedGoal.slice(0, 62).replace(/[,:;.\s]+$/, '')}...`
      : trimmedGoal.replace(/[.!?]+$/, '')

  const normalizedSentence =
    trimmedGoal.charAt(0).toLowerCase() + trimmedGoal.slice(1)
  const goalClause = /[.!?]$/.test(trimmedGoal)
    ? normalizedSentence
    : `${normalizedSentence}.`

  let subject
  let body

  if (tone === 'Formal') {
    subject = `Regarding: ${conciseTopic}`
    body = `Dear ${greetingName},\n\nI hope this message finds you well.\n\nI am writing to reach out regarding the following objective: ${goalClause} I would welcome the opportunity to connect briefly at your earliest convenience to discuss next steps and align on any details.\n\nPlease let me know if there is a suitable time for a brief conversation this week.\n\nSincerely,\n${senderName}\n${senderEmail}`
  } else if (tone === 'Friendly') {
    subject = `Quick note: ${conciseTopic}`
    body = `Hi ${greetingName},\n\nHope your week is going great!\n\nI wanted to reach out about ${goalClause} Would love to chat for a few minutes whenever you have a spare moment and see how we can move this forward together.\n\nLet me know what works best for you!\n\nBest,\n${senderName}\n${senderEmail}`
  } else {
    subject = `Connecting on: ${conciseTopic}`
    body = `Hi ${greetingName},\n\nI hope you're doing well.\n\nI'm reaching out to ${goalClause} I'd appreciate the chance to connect for a quick conversation and share a bit more context.\n\nWould you be open to a brief chat later this week?\n\nBest regards,\n${senderName}\n${senderEmail}`
  }

  return {
    plan: [
      {
        step: 1,
        title: 'Validate Recipient & Classify Risk',
        description: `${riskResult.riskLevel} risk — ${riskResult.reason}`,
      },
      {
        step: 2,
        title: 'Synthesize Strategy & Draft (Fallback Draft Engine)',
        description: `Generated ${tone.toLowerCase()} outreach draft using Fallback Draft Engine (Gemini 503) after all Gemini models experienced high demand.`,
      },
      {
        step: 3,
        title: 'Persist Run State to Supabase',
        description: 'Checkpoint execution plan, trace, and draft payload into agent_runs.',
      },
      {
        step: 4,
        title: 'Human-in-the-Loop Approval Gate',
        description: 'Pause execution so the operator can review, edit, and approve before sending.',
      },
      {
        step: 5,
        title: 'Dispatch via Brevo & Log Audit Trail',
        description: 'Send approved email via Brevo SMTP API and record email_logs entry.',
      },
    ],
    subject,
    body,
  }
}

function isNetworkFailure(err) {
  if (!err) return false
  if (err.name === 'AbortError' || err.isTimeout) return true
  const msg = err.message || ''
  return (
    err instanceof TypeError ||
    /failed to fetch|networkerror|network request failed|load failed|err_network/i.test(
      msg
    )
  )
}

function isRetryableGeminiError(status, message = '') {
  if ([404, 429, 500, 502, 503, 504].includes(status)) {
    return true
  }
  return /high demand|overloaded|capacity|resource[_ ]exhausted|rate limit|too many requests|temporarily unavailable|unavailable|not found|timed out|\b503\b|\b429\b/i.test(
    message
  )
}

function describeAttemptError(model, err) {
  if (err?.isTimeout || err?.name === 'AbortError') {
    return `[${model}] Request timed out after ${GEMINI_REQUEST_TIMEOUT_MS / 1000}s (${err.message || 'AbortError'})`
  }
  if (err?.status) {
    return `[${model}] HTTP ${err.status}: ${err.rawMessage || err.message}`
  }
  const errName = err?.name ? `${err.name}: ` : ''
  return `[${model}] ${errName}${err?.message || 'Unknown error'}`
}

function formatGeminiError(attemptErrors) {
  if (!attemptErrors || attemptErrors.length === 0) {
    return 'Gemini API request failed with an unknown error.'
  }
  if (attemptErrors.length === 1) {
    return `Gemini API error — ${attemptErrors[0]}`
  }
  return `Gemini API failed across models — ${attemptErrors.join(' | ')}`
}

async function fetchGeminiGenerateContent({
  endpoint,
  systemPrompt,
  includeThinkingBudget = true,
}) {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, GEMINI_REQUEST_TIMEOUT_MS)

  const generationConfig = {
    temperature: 0.7,
    responseMimeType: 'application/json',
    ...(includeThinkingBudget
      ? {
          thinkingConfig: {
            thinkingBudget: 0,
          },
        }
      : {}),
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: systemPrompt }],
          },
        ],
        generationConfig,
      }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const apiMsg =
        data?.error?.message || `Gemini API returned HTTP ${response.status}`
      const err = new Error(apiMsg)
      err.status = response.status
      err.rawMessage = apiMsg
      err.retryable = isRetryableGeminiError(response.status, apiMsg)
      throw err
    }

    return data
  } catch (err) {
    if (timedOut || err?.name === 'AbortError') {
      err.isTimeout = true
      err.retryable = true
    } else if (isNetworkFailure(err) && !err?.status) {
      err.retryable = true
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callGeminiWithFallback({ geminiKey, systemPrompt }) {
  const attemptedModels = []
  const attemptErrors = []
  let lastError = null
  let saw503 = false
  let sawNonTransientError = false

  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i]
    attemptedModels.push(model)
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`

    try {
      let data
      try {
        data = await fetchGeminiGenerateContent({
          endpoint,
          systemPrompt,
          includeThinkingBudget: true,
        })
      } catch (err) {
        const isThinkingBudgetRejected =
          err?.status === 400 &&
          /thinking|thinkingBudget|thinkingConfig/i.test(err.rawMessage || err.message || '')
        if (isThinkingBudgetRejected) {
          data = await fetchGeminiGenerateContent({
            endpoint,
            systemPrompt,
            includeThinkingBudget: false,
          })
        } else {
          throw err
        }
      }

      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text
      const parsed = safeParseGeminiJson(rawText)

      if (!parsed?.subject || !parsed?.body) {
        throw new Error('Gemini output was missing required subject or body fields.')
      }

      return {
        result: parsed,
        modelUsed: model,
        attemptedModels,
        attemptErrors,
        fallbackUsed: i > 0,
      }
    } catch (err) {
      lastError = err
      attemptErrors.push(describeAttemptError(model, err))

      const is503 = is503HighDemandError(err)
      if (is503) {
        saw503 = true
      } else if (err?.status && ![404, 429, 500, 502, 504].includes(err.status)) {
        sawNonTransientError = true
      }

      const hasMoreModels = i < GEMINI_MODELS.length - 1
      if (hasMoreModels && err.retryable) {
        if (is503) {
          await sleep(GEMINI_503_RETRY_DELAY_MS)
        }
        continue
      }

      const detailedError = new Error(formatGeminiError(attemptErrors))
      detailedError.attemptedModels = attemptedModels
      detailedError.attemptErrors = attemptErrors
      detailedError.status = err.status
      detailedError.allGemini503 = saw503 && !sawNonTransientError
      throw detailedError
    }
  }

  const fallbackErr = new Error(
    attemptErrors.length
      ? formatGeminiError(attemptErrors)
      : lastError?.message || 'All Gemini models failed.'
  )
  fallbackErr.attemptedModels = attemptedModels
  fallbackErr.attemptErrors = attemptErrors
  fallbackErr.allGemini503 = saw503 && !sawNonTransientError
  throw fallbackErr
}

export async function runPlanAndDraftAgent({
  user,
  recipientEmail,
  goal,
  tone,
  onProgress,
}) {
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY
  if (!geminiKey) {
    throw new Error('Missing VITE_GEMINI_API_KEY in .env configuration.')
  }

  const senderEmail = user.email
  const senderName = deriveSenderName(user)
  const cleanRecipient = recipientEmail.trim()
  const cleanGoal = goal.trim()

  if (!cleanGoal) {
    throw new Error('Please describe your outreach goal or purpose.')
  }

  let plan = buildDefaultPlan(cleanGoal, tone, 'PENDING')
  const trace = []

  const emit = (status = 'running', draftPayload = null) => {
    if (onProgress) {
      onProgress({
        status,
        plan: plan.map((s) => ({ ...s })),
        trace: [...trace],
        draft_payload: draftPayload,
      })
    }
  }

  emit('running')

  // STEP 1: Validate email & classify risk
  const t1Start = performance.now()
  let riskResult
  try {
    riskResult = classifyRisk(cleanRecipient, senderEmail)
    const t1Duration = Math.max(1, Math.round(performance.now() - t1Start))
    plan[0] = {
      ...plan[0],
      description: `${riskResult.riskLevel} risk — ${riskResult.reason}`,
      status: 'done',
    }
    trace.push({
      id: `trace-${Date.now()}-1`,
      step: 1,
      tool: 'validate_and_classify_risk',
      status: 'success',
      durationMs: t1Duration,
      timestamp: new Date().toISOString(),
      inputs: {
        recipientEmail: cleanRecipient,
        senderEmail,
      },
      outputs: {
        validEmail: true,
        riskLevel: riskResult.riskLevel,
        isSelfTest: riskResult.isSelfTest,
        reason: riskResult.reason,
      },
    })
    emit('running')
  } catch (err) {
    const t1Duration = Math.max(1, Math.round(performance.now() - t1Start))
    plan[0] = { ...plan[0], status: 'failed' }
    trace.push({
      id: `trace-${Date.now()}-1`,
      step: 1,
      tool: 'validate_and_classify_risk',
      status: 'error',
      durationMs: t1Duration,
      timestamp: new Date().toISOString(),
      inputs: { recipientEmail: cleanRecipient, senderEmail },
      outputs: { error: err.message },
    })
    emit('failed')
    throw err
  }

  // STEP 2: Call Gemini API for 5-step execution plan + tailored subject & body
  const t2Start = performance.now()

  const systemPrompt = `You are MailPilot, an autonomous AI Email Outreach Agent with a strict Human-in-the-Loop approval gate.
Given the outreach parameters below, generate:
1. A 5-step execution plan specific to this outreach task (steps 1 through 5).
   - Step 1 must cover recipient validation & ${riskResult.riskLevel} risk classification.
   - Step 2 must cover goal analysis & tone calibration (${tone}).
   - Step 3 must cover drafting the personalized email & checkpointing state.
   - Step 4 must be the Human-in-the-Loop approval gate.
   - Step 5 must cover Brevo SMTP dispatch & Supabase audit logging.
2. A compelling email subject line.
3. A clear, ready-to-send email body in a "${tone}" tone, signed off by "${senderName}" (${senderEmail}). Do not include placeholder brackets like [Your Name] or [Company] unless genuinely missing; write a polished, natural email ready to send.

Outreach Context:
- Sender Name: ${senderName}
- Sender Email: ${senderEmail}
- Recipient Email: ${cleanRecipient}
- Risk Level: ${riskResult.riskLevel}
- Tone: ${tone}
- Goal / Purpose: ${cleanGoal}

Return strictly valid JSON with this exact schema:
{
  "plan": [
    { "step": 1, "title": "string", "description": "string" },
    { "step": 2, "title": "string", "description": "string" },
    { "step": 3, "title": "string", "description": "string" },
    { "step": 4, "title": "string", "description": "string" },
    { "step": 5, "title": "string", "description": "string" }
  ],
  "subject": "string",
  "body": "string"
}`

  let geminiResult
  let draftEngine = 'gemini'
  try {
    const {
      result,
      modelUsed,
      attemptedModels,
      attemptErrors,
      fallbackUsed,
    } = await callGeminiWithFallback({ geminiKey, systemPrompt })
    geminiResult = result
    draftEngine = modelUsed

    const t2Duration = Math.max(1, Math.round(performance.now() - t2Start))

    if (Array.isArray(geminiResult.plan) && geminiResult.plan.length === 5) {
      plan = geminiResult.plan.map((item, idx) => ({
        step: item.step || idx + 1,
        title: item.title || plan[idx].title,
        description: item.description || plan[idx].description,
        status: idx < 2 ? 'done' : 'pending',
      }))
    } else {
      plan[1] = { ...plan[1], status: 'done' }
    }

    trace.push({
      id: `trace-${Date.now()}-2`,
      step: 2,
      tool: 'gemini_generate_plan_and_draft',
      status: 'success',
      durationMs: t2Duration,
      timestamp: new Date().toISOString(),
      inputs: {
        model: GEMINI_MODELS[0],
        fallbackModels: GEMINI_MODELS.slice(1),
        timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
        tone,
        riskLevel: riskResult.riskLevel,
        goal: cleanGoal,
      },
      outputs: {
        modelUsed,
        attemptedModels,
        fallbackUsed,
        ...(attemptErrors?.length ? { priorAttemptErrors: attemptErrors } : {}),
        subject: geminiResult.subject,
        bodyLength: geminiResult.body.length,
        planStepsGenerated: plan.length,
      },
    })
    emit('running')
  } catch (err) {
    const t2Duration = Math.max(1, Math.round(performance.now() - t2Start))

    if (err.allGemini503) {
      geminiResult = buildFallbackDraftPlan({
        senderName,
        senderEmail,
        recipientEmail: cleanRecipient,
        goal: cleanGoal,
        tone,
        riskResult,
      })
      draftEngine = 'Fallback Draft Engine (Gemini 503)'

      plan = geminiResult.plan.map((item, idx) => ({
        step: item.step || idx + 1,
        title: item.title,
        description: item.description,
        status: idx < 2 ? 'done' : 'pending',
      }))

      trace.push({
        id: `trace-${Date.now()}-2`,
        step: 2,
        tool: 'gemini_generate_plan_and_draft',
        status: 'success',
        durationMs: t2Duration,
        timestamp: new Date().toISOString(),
        inputs: {
          model: GEMINI_MODELS[0],
          fallbackModels: GEMINI_MODELS.slice(1),
          timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
          retry503DelayMs: GEMINI_503_RETRY_DELAY_MS,
          tone,
          riskLevel: riskResult.riskLevel,
          goal: cleanGoal,
        },
        outputs: {
          engine: 'Fallback Draft Engine (Gemini 503)',
          note: 'Fallback Draft Engine (Gemini 503)',
          fallbackUsed: true,
          attemptedModels: err.attemptedModels || GEMINI_MODELS,
          attemptErrors: err.attemptErrors || [err.message],
          subject: geminiResult.subject,
          bodyLength: geminiResult.body.length,
          planStepsGenerated: plan.length,
        },
      })
      emit('running')
    } else {
      plan[1] = { ...plan[1], status: 'failed' }
      trace.push({
        id: `trace-${Date.now()}-2`,
        step: 2,
        tool: 'gemini_generate_plan_and_draft',
        status: 'error',
        durationMs: t2Duration,
        timestamp: new Date().toISOString(),
        inputs: {
          model: GEMINI_MODELS[0],
          fallbackModels: GEMINI_MODELS.slice(1),
          timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
          tone,
          goal: cleanGoal,
        },
        outputs: {
          error: err.message,
          attemptedModels: err.attemptedModels || [GEMINI_MODELS[0]],
          attemptErrors: err.attemptErrors || [err.message],
        },
      })
      emit('failed')
      throw err
    }
  }

  // STEP 3: Persist agent_run to Supabase and pause for HITL approval
  const t3Start = performance.now()
  const draftPayload = {
    recipientEmail: cleanRecipient,
    subject: geminiResult.subject,
    body: geminiResult.body,
    tone,
    riskLevel: riskResult.riskLevel,
    riskReason: riskResult.reason,
    draftEngine,
  }

  plan[2] = { ...plan[2], status: 'done' }
  plan[3] = { ...plan[3], status: 'awaiting_approval' }
  plan[4] = { ...plan[4], status: 'pending' }

  const prePersistTraceEntry = {
    id: `trace-${Date.now()}-3`,
    step: 3,
    tool: 'supabase_insert_agent_run',
    status: 'success',
    durationMs: 0,
    timestamp: new Date().toISOString(),
    inputs: {
      table: 'agent_runs',
      status: 'awaiting_approval',
      recipientEmail: cleanRecipient,
    },
    outputs: {
      checkpointStatus: 'awaiting_approval',
    },
  }

  const gateTraceEntry = {
    id: `trace-${Date.now()}-4`,
    step: 4,
    tool: 'human_approval_gate',
    status: 'awaiting',
    durationMs: 0,
    timestamp: new Date().toISOString(),
    inputs: {
      riskLevel: riskResult.riskLevel,
      recipientEmail: cleanRecipient,
      subject: draftPayload.subject,
    },
    outputs: {
      state: 'Paused for Human-in-the-Loop review',
    },
  }

  const traceForInsert = [...trace, prePersistTraceEntry, gateTraceEntry]

  try {
    const { data: insertedRun, error: insertError } = await supabase
      .from('agent_runs')
      .insert({
        user_id: user.id,
        sender_name: senderName,
        sender_email: senderEmail,
        goal: cleanGoal,
        status: 'awaiting_approval',
        plan,
        trace: traceForInsert,
        draft_payload: draftPayload,
      })
      .select()
      .single()

    if (insertError) {
      throw new Error(`Supabase insert failed: ${insertError.message}`)
    }

    const t3Duration = Math.max(1, Math.round(performance.now() - t3Start))
    prePersistTraceEntry.durationMs = t3Duration
    prePersistTraceEntry.outputs = {
      runId: insertedRun.id,
      checkpointStatus: 'awaiting_approval',
    }

    // Best-effort update of exact insert duration into trace
    await supabase
      .from('agent_runs')
      .update({ trace: [...trace, prePersistTraceEntry, gateTraceEntry] })
      .eq('id', insertedRun.id)

    const finalRun = {
      ...insertedRun,
      trace: [...trace, prePersistTraceEntry, gateTraceEntry],
    }

    emit('awaiting_approval', draftPayload)
    return finalRun
  } catch (err) {
    const t3Duration = Math.max(1, Math.round(performance.now() - t3Start))
    plan[2] = { ...plan[2], status: 'failed' }
    plan[3] = { ...plan[3], status: 'pending' }
    trace.push({
      id: `trace-${Date.now()}-3`,
      step: 3,
      tool: 'supabase_insert_agent_run',
      status: 'error',
      durationMs: t3Duration,
      timestamp: new Date().toISOString(),
      inputs: { table: 'agent_runs', status: 'awaiting_approval' },
      outputs: { error: err.message },
    })
    emit('failed', draftPayload)
    throw err
  }
}

export async function approveAndSendEmail({
  run,
  user,
  recipientEmail,
  subject,
  body,
}) {
  const brevoApiKey = import.meta.env.VITE_BREVO_API_KEY
  const brevoSenderEmail = import.meta.env.VITE_BREVO_SENDER_EMAIL

  if (!brevoApiKey || !brevoSenderEmail) {
    throw new Error('Missing VITE_BREVO_API_KEY or VITE_BREVO_SENDER_EMAIL in .env.')
  }

  const cleanRecipient = recipientEmail.trim()
  const cleanSubject = subject.trim()
  const cleanBody = body.trim()

  const riskResult = classifyRisk(cleanRecipient, user.email)
  if (!cleanSubject || !cleanBody) {
    throw new Error('Subject and email body cannot be empty.')
  }

  const senderName = run.sender_name || deriveSenderName(user)
  const senderEmail = run.sender_email || user.email

  const updatedPlan = (run.plan || []).map((stepObj) => {
    if (stepObj.step === 4) return { ...stepObj, status: 'done' }
    return stepObj
  })

  const existingTrace = Array.isArray(run.trace)
    ? run.trace.map((item) =>
        item.tool === 'human_approval_gate'
          ? {
              ...item,
              status: 'success',
              outputs: {
                decision: 'approved',
                approvedBy: senderEmail,
                approvedAt: new Date().toISOString(),
              },
            }
          : item
      )
    : []

  const updatedDraftPayload = {
    ...(run.draft_payload || {}),
    recipientEmail: cleanRecipient,
    subject: cleanSubject,
    body: cleanBody,
    riskLevel: riskResult.riskLevel,
    riskReason: riskResult.reason,
  }

  // Call Brevo REST API
  const brevoStart = performance.now()
  let brevoData = null
  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': brevoApiKey,
      },
      body: JSON.stringify({
        sender: {
          name: `${senderName} via MailPilot`,
          email: brevoSenderEmail,
        },
        replyTo: {
          email: senderEmail,
        },
        to: [
          {
            email: cleanRecipient,
          },
        ],
        subject: cleanSubject,
        textContent: cleanBody,
      }),
    })

    brevoData = await brevoRes.json().catch(() => ({}))
    if (!brevoRes.ok) {
      const msg =
        brevoData?.message ||
        brevoData?.code ||
        `Brevo API returned HTTP ${brevoRes.status}`
      throw new Error(msg)
    }
  } catch (err) {
    const cleanErrorMsg = isNetworkFailure(err)
      ? `Brevo API network error (${err.name ? `${err.name}: ` : ''}${err.message || 'request failed'})`
      : err.message || 'Brevo email dispatch failed.'
    const brevoDuration = Math.max(1, Math.round(performance.now() - brevoStart))
    const failedPlan = updatedPlan.map((stepObj) =>
      stepObj.step === 5 ? { ...stepObj, status: 'failed' } : stepObj
    )
    const failedTrace = [
      ...existingTrace,
      {
        id: `trace-${Date.now()}-5`,
        step: 5,
        tool: 'brevo_send_smtp_email',
        status: 'error',
        durationMs: brevoDuration,
        timestamp: new Date().toISOString(),
        inputs: {
          sender: `${senderName} via MailPilot <${brevoSenderEmail}>`,
          replyTo: senderEmail,
          to: cleanRecipient,
          subject: cleanSubject,
        },
        outputs: { error: cleanErrorMsg },
      },
    ]

    await supabase.from('email_logs').insert({
      user_id: user.id,
      run_id: run.id,
      sender_name: senderName,
      sender_email: senderEmail,
      recipient_email: cleanRecipient,
      subject: cleanSubject,
      body: cleanBody,
      status: 'failed',
      provider_message_id: null,
      risk_level: riskResult.riskLevel,
    })

    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        plan: failedPlan,
        trace: failedTrace,
        draft_payload: updatedDraftPayload,
        updated_at: new Date().toISOString(),
      })
      .eq('id', run.id)

    throw new Error(cleanErrorMsg)
  }

  const brevoDuration = Math.max(1, Math.round(performance.now() - brevoStart))
  const messageId = brevoData?.messageId || null

  const brevoTraceEntry = {
    id: `trace-${Date.now()}-5`,
    step: 5,
    tool: 'brevo_send_smtp_email',
    status: 'success',
    durationMs: brevoDuration,
    timestamp: new Date().toISOString(),
    inputs: {
      sender: `${senderName} via MailPilot <${brevoSenderEmail}>`,
      replyTo: senderEmail,
      to: cleanRecipient,
      subject: cleanSubject,
    },
    outputs: {
      messageId,
      provider: 'brevo',
      delivered: true,
    },
  }

  // Insert audit record into email_logs
  const logStart = performance.now()
  const { data: emailLog, error: logError } = await supabase
    .from('email_logs')
    .insert({
      user_id: user.id,
      run_id: run.id,
      sender_name: senderName,
      sender_email: senderEmail,
      recipient_email: cleanRecipient,
      subject: cleanSubject,
      body: cleanBody,
      status: 'sent',
      provider_message_id: messageId,
      risk_level: riskResult.riskLevel,
    })
    .select()
    .single()

  if (logError) {
    throw new Error(`Email sent via Brevo, but audit logging failed: ${logError.message}`)
  }
  const logDuration = Math.max(1, Math.round(performance.now() - logStart))

  const logTraceEntry = {
    id: `trace-${Date.now()}-6`,
    step: 5,
    tool: 'supabase_insert_email_log',
    status: 'success',
    durationMs: logDuration,
    timestamp: new Date().toISOString(),
    inputs: {
      table: 'email_logs',
      runId: run.id,
      recipientEmail: cleanRecipient,
    },
    outputs: {
      emailLogId: emailLog.id,
      status: 'sent',
      providerMessageId: messageId,
    },
  }

  const completedPlan = updatedPlan.map((stepObj) =>
    stepObj.step === 5 ? { ...stepObj, status: 'done' } : stepObj
  )
  const completedTrace = [...existingTrace, brevoTraceEntry, logTraceEntry]

  const { data: updatedRun, error: updateError } = await supabase
    .from('agent_runs')
    .update({
      status: 'completed',
      plan: completedPlan,
      trace: completedTrace,
      draft_payload: updatedDraftPayload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', run.id)
    .select()
    .single()

  if (updateError) {
    throw new Error(`Email sent, but failed to update agent run: ${updateError.message}`)
  }

  return { updatedRun, emailLog, messageId }
}

export async function rejectAgentDraft({ run, user, draftPayload }) {
  const rejectedPlan = (run.plan || []).map((stepObj) => {
    if (stepObj.step === 4) return { ...stepObj, status: 'failed' }
    if (stepObj.step === 5) return { ...stepObj, status: 'failed' }
    return stepObj
  })

  const rejectedTrace = Array.isArray(run.trace)
    ? run.trace.map((item) =>
        item.tool === 'human_approval_gate'
          ? {
              ...item,
              status: 'error',
              outputs: {
                decision: 'rejected',
                rejectedBy: user.email,
                rejectedAt: new Date().toISOString(),
              },
            }
          : item
      )
    : []

  const { data: updatedRun, error } = await supabase
    .from('agent_runs')
    .update({
      status: 'rejected',
      plan: rejectedPlan,
      trace: rejectedTrace,
      draft_payload: draftPayload || run.draft_payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', run.id)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to reject draft: ${error.message}`)
  }

  return updatedRun
}
