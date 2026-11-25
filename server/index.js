import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load server/.env first if present, then fall back to root .env for local dev
dotenv.config({ path: path.join(__dirname, '.env') })
dotenv.config({ path: path.join(__dirname, '..', '.env') })

const PORT = Number(process.env.PORT) || 8787
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

const GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-3.8-flash',
  'gemini-3.8-pro',
]
const GEMINI_REQUEST_TIMEOUT_MS = 60000
const GEMINI_503_RETRY_DELAY_MS = 1500
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || ''
}

function getBrevoConfig() {
  return {
    apiKey: process.env.BREVO_API_KEY || process.env.VITE_BREVO_API_KEY || '',
    senderEmail:
      process.env.BREVO_SENDER_EMAIL || process.env.VITE_BREVO_SENDER_EMAIL || '',
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function classifyRisk(recipientEmail, senderEmail) {
  const normalizedRecipient = (recipientEmail || '').trim().toLowerCase()
  const normalizedSender = (senderEmail || '').trim().toLowerCase()

  if (!EMAIL_REGEX.test(normalizedRecipient)) {
    const err = new Error('Please provide a valid recipientEmail.')
    err.statusCode = 400
    throw err
  }

  const isSelfTest = Boolean(normalizedSender) && normalizedRecipient === normalizedSender
  return {
    riskLevel: isSelfTest ? 'MEDIUM' : 'HIGH',
    isSelfTest,
    reason: isSelfTest
      ? 'Self-test outreach detected (recipient matches sender).'
      : 'External recipient detected; requires mandatory human approval before dispatch.',
  }
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

function is503HighDemandError(err) {
  if (!err) return false
  if (err.status === 503) return true
  const msg = err.rawMessage || err.message || ''
  return /high demand|overloaded|service unavailable|\b503\b/i.test(msg)
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
    return `[${model}] Request timed out after ${GEMINI_REQUEST_TIMEOUT_MS / 1000}s`
  }
  if (err?.status) {
    return `[${model}] HTTP ${err.status}: ${err.rawMessage || err.message}`
  }
  const errName = err?.name ? `${err.name}: ` : ''
  return `[${model}] ${errName}${err?.message || 'Unknown error'}`
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
    body = `Dear ${greetingName},\n\nI hope this message finds you well.\n\nI am writing to reach out regarding the following objective: ${goalClause} I would welcome the opportunity to connect briefly at your earliest convenience to discuss next steps and align on any details.\n\nPlease let me know if there is a suitable time for a brief conversation this week.\n\nSincerely,\n${senderName}${senderEmail ? `\n${senderEmail}` : ''}`
  } else if (tone === 'Friendly') {
    subject = `Quick note: ${conciseTopic}`
    body = `Hi ${greetingName},\n\nHope your week is going great!\n\nI wanted to reach out about ${goalClause} Would love to chat for a few minutes whenever you have a spare moment and see how we can move this forward together.\n\nLet me know what works best for you!\n\nBest,\n${senderName}${senderEmail ? `\n${senderEmail}` : ''}`
  } else {
    subject = `Connecting on: ${conciseTopic}`
    body = `Hi ${greetingName},\n\nI hope you're doing well.\n\nI'm reaching out to ${goalClause} I'd appreciate the chance to connect for a quick conversation and share a bit more context.\n\nWould you be open to a brief chat later this week?\n\nBest regards,\n${senderName}${senderEmail ? `\n${senderEmail}` : ''}`
  }

  return {
    plan: [
      {
        step: 1,
        title: 'Validate Recipient & Classify Risk',
        description: `${riskResult.riskLevel} risk — ${riskResult.reason}`,
        status: 'done',
      },
      {
        step: 2,
        title: 'Synthesize Strategy & Draft (Fallback Draft Engine)',
        description: `Generated ${tone.toLowerCase()} outreach draft using Fallback Draft Engine (Gemini 503) after all Gemini models experienced high demand.`,
        status: 'done',
      },
      {
        step: 3,
        title: 'Persist Run State',
        description: 'Checkpoint execution plan, trace, and draft payload.',
        status: 'done',
      },
      {
        step: 4,
        title: 'Human-in-the-Loop Approval Gate',
        description: 'Pause execution for operator review, editing, and sign-off.',
        status: 'awaiting_approval',
      },
      {
        step: 5,
        title: 'Dispatch via Brevo & Log Audit Trail',
        description: 'Send approved email via Brevo SMTP API and record audit log.',
        status: 'pending',
      },
    ],
    subject,
    body,
  }
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
    ...(includeThinkingBudget ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
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
    } else if (!err?.status) {
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

      const detailedError = new Error(
        `Gemini API failed across models — ${attemptErrors.join(' | ')}`
      )
      detailedError.attemptedModels = attemptedModels
      detailedError.attemptErrors = attemptErrors
      detailedError.status = err.status
      detailedError.allGemini503 = saw503 && !sawNonTransientError
      throw detailedError
    }
  }

  const fallbackErr = new Error(
    attemptErrors.length
      ? `Gemini API failed across models — ${attemptErrors.join(' | ')}`
      : lastError?.message || 'All Gemini models failed.'
  )
  fallbackErr.attemptedModels = attemptedModels
  fallbackErr.attemptErrors = attemptErrors
  fallbackErr.allGemini503 = saw503 && !sawNonTransientError
  throw fallbackErr
}

const app = express()

const allowedOrigins =
  CORS_ORIGIN === '*'
    ? '*'
    : CORS_ORIGIN.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)

app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
)
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  const geminiKey = getGeminiApiKey()
  const brevo = getBrevoConfig()
  res.status(200).json({
    status: 'ok',
    service: 'mailpilot-backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime() * 10) / 10,
    config: {
      geminiConfigured: Boolean(geminiKey),
      brevoConfigured: Boolean(brevo.apiKey),
      senderConfigured: Boolean(brevo.senderEmail),
    },
  })
})

app.post('/api/draft', async (req, res) => {
  const {
    recipientEmail,
    goal,
    tone = 'Semi-Formal',
    senderName = 'MailPilot User',
    senderEmail = '',
  } = req.body || {}

  const cleanRecipient = (recipientEmail || '').trim()
  const cleanGoal = (goal || '').trim()
  const cleanSenderName = (senderName || 'MailPilot User').trim()
  const cleanSenderEmail = (senderEmail || '').trim()

  if (!cleanGoal) {
    return res.status(400).json({
      error: 'Please provide a non-empty outreach goal.',
    })
  }

  let riskResult
  try {
    riskResult = classifyRisk(cleanRecipient, cleanSenderEmail)
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message })
  }

  const geminiKey = getGeminiApiKey()
  if (!geminiKey) {
    return res.status(500).json({
      error: 'Missing GEMINI_API_KEY (or VITE_GEMINI_API_KEY) on the server.',
    })
  }

  const trace = [
    {
      id: `trace-${Date.now()}-1`,
      step: 1,
      tool: 'validate_and_classify_risk',
      status: 'success',
      durationMs: 1,
      timestamp: new Date().toISOString(),
      inputs: { recipientEmail: cleanRecipient, senderEmail: cleanSenderEmail },
      outputs: { validEmail: true, ...riskResult },
    },
  ]

  const systemPrompt = `You are MailPilot, an autonomous AI Email Outreach Agent with a strict Human-in-the-Loop approval gate.
Given the outreach parameters below, generate:
1. A 5-step execution plan specific to this outreach task (steps 1 through 5).
   - Step 1 must cover recipient validation & ${riskResult.riskLevel} risk classification.
   - Step 2 must cover goal analysis & tone calibration (${tone}).
   - Step 3 must cover drafting the personalized email & checkpointing state.
   - Step 4 must be the Human-in-the-Loop approval gate.
   - Step 5 must cover Brevo SMTP dispatch & audit logging.
2. A compelling email subject line.
3. A clear, ready-to-send email body in a "${tone}" tone, signed off by "${cleanSenderName}"${cleanSenderEmail ? ` (${cleanSenderEmail})` : ''}.

Outreach Context:
- Sender Name: ${cleanSenderName}
- Sender Email: ${cleanSenderEmail || 'Not provided'}
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

  const t2Start = Date.now()
  try {
    const {
      result,
      modelUsed,
      attemptedModels,
      attemptErrors,
      fallbackUsed,
    } = await callGeminiWithFallback({ geminiKey, systemPrompt })

    const plan = Array.isArray(result.plan) && result.plan.length === 5
      ? result.plan.map((item, idx) => ({
          step: item.step || idx + 1,
          title: item.title || `Step ${idx + 1}`,
          description: item.description || '',
          status: idx < 3 ? 'done' : idx === 3 ? 'awaiting_approval' : 'pending',
        }))
      : buildFallbackDraftPlan({
          senderName: cleanSenderName,
          senderEmail: cleanSenderEmail,
          recipientEmail: cleanRecipient,
          goal: cleanGoal,
          tone,
          riskResult,
        }).plan

    trace.push({
      id: `trace-${Date.now()}-2`,
      step: 2,
      tool: 'gemini_generate_plan_and_draft',
      status: 'success',
      durationMs: Math.max(1, Date.now() - t2Start),
      timestamp: new Date().toISOString(),
      inputs: {
        model: GEMINI_MODELS[0],
        fallbackModels: GEMINI_MODELS.slice(1),
        tone,
        riskLevel: riskResult.riskLevel,
      },
      outputs: {
        modelUsed,
        attemptedModels,
        fallbackUsed,
        ...(attemptErrors?.length ? { priorAttemptErrors: attemptErrors } : {}),
        subject: result.subject,
        bodyLength: result.body.length,
      },
    })

    return res.status(200).json({
      status: 'awaiting_approval',
      riskLevel: riskResult.riskLevel,
      riskReason: riskResult.reason,
      plan,
      draft: {
        recipientEmail: cleanRecipient,
        subject: result.subject,
        body: result.body,
        tone,
        riskLevel: riskResult.riskLevel,
        riskReason: riskResult.reason,
        draftEngine: modelUsed,
      },
      trace,
    })
  } catch (err) {
    const durationMs = Math.max(1, Date.now() - t2Start)

    if (err.allGemini503) {
      const fallback = buildFallbackDraftPlan({
        senderName: cleanSenderName,
        senderEmail: cleanSenderEmail,
        recipientEmail: cleanRecipient,
        goal: cleanGoal,
        tone,
        riskResult,
      })

      trace.push({
        id: `trace-${Date.now()}-2`,
        step: 2,
        tool: 'gemini_generate_plan_and_draft',
        status: 'success',
        durationMs,
        timestamp: new Date().toISOString(),
        inputs: {
          model: GEMINI_MODELS[0],
          fallbackModels: GEMINI_MODELS.slice(1),
          tone,
          riskLevel: riskResult.riskLevel,
        },
        outputs: {
          engine: 'Fallback Draft Engine (Gemini 503)',
          note: 'Fallback Draft Engine (Gemini 503)',
          fallbackUsed: true,
          attemptedModels: err.attemptedModels || GEMINI_MODELS,
          attemptErrors: err.attemptErrors || [err.message],
          subject: fallback.subject,
          bodyLength: fallback.body.length,
        },
      })

      return res.status(200).json({
        status: 'awaiting_approval',
        riskLevel: riskResult.riskLevel,
        riskReason: riskResult.reason,
        plan: fallback.plan,
        draft: {
          recipientEmail: cleanRecipient,
          subject: fallback.subject,
          body: fallback.body,
          tone,
          riskLevel: riskResult.riskLevel,
          riskReason: riskResult.reason,
          draftEngine: 'Fallback Draft Engine (Gemini 503)',
        },
        trace,
      })
    }

    return res.status(err.status && err.status >= 400 ? err.status : 502).json({
      error: err.message || 'Gemini draft generation failed.',
      attemptedModels: err.attemptedModels || GEMINI_MODELS,
      attemptErrors: err.attemptErrors || [],
    })
  }
})

app.post('/api/send', async (req, res) => {
  const {
    recipientEmail,
    subject,
    body,
    senderName = 'MailPilot User',
    senderEmail = '',
    replyToEmail = '',
  } = req.body || {}

  const cleanRecipient = (recipientEmail || '').trim()
  const cleanSubject = (subject || '').trim()
  const cleanBody = (body || '').trim()
  const cleanSenderName = (senderName || 'MailPilot User').trim()

  if (!EMAIL_REGEX.test(cleanRecipient)) {
    return res.status(400).json({ error: 'Please provide a valid recipientEmail.' })
  }
  if (!cleanSubject || !cleanBody) {
    return res.status(400).json({ error: 'Subject and email body are required.' })
  }

  const brevo = getBrevoConfig()
  if (!brevo.apiKey || !brevo.senderEmail) {
    return res.status(500).json({
      error:
        'Missing BREVO_API_KEY or BREVO_SENDER_EMAIL (or VITE_BREVO_*) on the server.',
    })
  }

  const replyTo = (replyToEmail || senderEmail || brevo.senderEmail).trim()
  const startMs = Date.now()

  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': brevo.apiKey,
      },
      body: JSON.stringify({
        sender: {
          name: `${cleanSenderName} via MailPilot`,
          email: brevo.senderEmail,
        },
        replyTo: {
          email: replyTo,
        },
        to: [{ email: cleanRecipient }],
        subject: cleanSubject,
        textContent: cleanBody,
      }),
    })

    const brevoData = await brevoRes.json().catch(() => ({}))
    if (!brevoRes.ok) {
      const msg =
        brevoData?.message ||
        brevoData?.code ||
        `Brevo API returned HTTP ${brevoRes.status}`
      return res.status(brevoRes.status >= 400 ? brevoRes.status : 502).json({
        error: msg,
        provider: 'brevo',
      })
    }

    return res.status(200).json({
      ok: true,
      provider: 'brevo',
      messageId: brevoData?.messageId || null,
      recipientEmail: cleanRecipient,
      subject: cleanSubject,
      durationMs: Math.max(1, Date.now() - startMs),
    })
  } catch (err) {
    return res.status(502).json({
      error: `Brevo API network error: ${err.message || 'request failed'}`,
      provider: 'brevo',
    })
  }
})

app.listen(PORT, () => {
  console.log(`MailPilot backend listening on http://localhost:${PORT}`)
})
