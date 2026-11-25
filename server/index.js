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

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash']
const GEMINI_REQUEST_TIMEOUT_MS = 12000
const GEMINI_503_RETRY_DELAY_MS = 500
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

function deriveRecipientCompany(recipientEmail) {
  const domain = ((recipientEmail || '').split('@')[1] || '').toLowerCase()
  if (!domain) return ''
  const personalDomains = new Set([
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'icloud.com',
    'me.com',
    'proton.me',
    'protonmail.com',
    'aol.com',
  ])
  if (personalDomains.has(domain)) return ''
  const org = domain.split('.')[0] || ''
  if (!org || org.length < 2) return ''
  return org.charAt(0).toUpperCase() + org.slice(1)
}

function cleanGoalActionPhrase(goal) {
  return goal
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /^(please\s+)?(can you\s+|could you\s+)?(write|draft|compose|send|create|generate)\s+(an?\s+)?(short\s+|quick\s+|brief\s+|formal\s+|friendly\s+)?(email|message|note|outreach)\s+(to\s+[^,.]+\s+)?(about|regarding|to|for|asking|inviting|introducing|following up on)?\s*/i,
      ''
    )
    .trim()
}

function detectOutreachIntent(goal) {
  const text = goal.toLowerCase()
  if (/\b(thank|appreciate|grateful|gratitude)\b/.test(text)) return 'thankyou'
  if (/\b(follow[\s-]?up|checking in|circle back|touch base|reminder)\b/.test(text))
    return 'followup'
  if (/\b(apply|application|job|role|position|resume|cv|interview|internship|referral)\b/.test(text))
    return 'application'
  if (/\b(invite|invitation|webinar|event|workshop|meetup|conference|lunch|coffee)\b/.test(text))
    return 'invitation'
  if (/\b(partner|partnership|collaborat|joint|integrate|co-market)\b/.test(text))
    return 'partnership'
  if (/\b(demo|meeting|call|schedule|calendar|slot|15-min|30-min|chat|sync|catch up)\b/.test(text))
    return 'meeting'
  if (/\b(introduc|pitch|product|platform|solution|offer|service|proposal|pricing|trial)\b/.test(text))
    return 'sales'
  if (/\b(update|status|progress|report|launch|release|announcement)\b/.test(text))
    return 'update'
  return 'general'
}

function capitalizeSentence(text) {
  if (!text) return ''
  const clean = text.trim()
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

function ensurePeriod(text) {
  const clean = (text || '').trim()
  if (!clean) return ''
  return /[.!?]$/.test(clean) ? clean : `${clean}.`
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
  const company = deriveRecipientCompany(recipientEmail)
  const rawGoal = goal.replace(/\s+/g, ' ').trim()
  const cleanedAction = cleanGoalActionPhrase(rawGoal) || rawGoal
  const intent = detectOutreachIntent(rawGoal)

  const topicBase = cleanedAction.replace(/[.!?]+$/, '')
  const conciseTopic =
    topicBase.length > 62
      ? `${topicBase.slice(0, 59).replace(/[,:;.\s]+$/, '')}...`
      : topicBase
  const topicTitle = capitalizeSentence(conciseTopic)

  const actionClause = ensurePeriod(
    cleanedAction.charAt(0).toLowerCase() + cleanedAction.slice(1)
  )
  const actionSentence = ensurePeriod(capitalizeSentence(cleanedAction))
  const companyRef = company ? ` at ${company}` : ''
  const emailFooter = senderEmail ? `\n${senderEmail}` : ''

  const openingByTone = {
    Formal: `Dear ${greetingName},\n\nI hope this message finds you well.`,
    'Semi-Formal': `Hi ${greetingName},\n\nI hope you're doing well.`,
    Friendly: `Hi ${greetingName},\n\nHope your week is going great!`,
  }

  const signoffByTone = {
    Formal: `Sincerely,\n${senderName}${emailFooter}`,
    'Semi-Formal': `Best regards,\n${senderName}${emailFooter}`,
    Friendly: `Best,\n${senderName}${emailFooter}`,
  }

  let subjectPrefix = {
    Formal: 'Regarding:',
    'Semi-Formal': 'Connecting on:',
    Friendly: 'Quick note:',
  }[tone] || 'Connecting on:'

  let bodyCore = ''
  let cta = ''

  switch (intent) {
    case 'meeting':
      subjectPrefix = tone === 'Formal' ? 'Meeting Request:' : tone === 'Friendly' ? 'Quick chat:' : 'Scheduling:'
      bodyCore =
        tone === 'Formal'
          ? `I am writing to arrange a brief conversation regarding ${actionClause} Given your work${companyRef}, I believe a focused discussion would be mutually valuable.`
          : tone === 'Friendly'
          ? `I'd love to set up a quick conversation about ${actionClause} It would be great to hear your thoughts${companyRef ? ` on what you're building at ${company}` : ''} and walk through a few ideas together.`
          : `I'm reaching out to coordinate a brief call regarding ${actionClause} I'd value the chance to connect${companyRef} and share a concise overview.`
      cta =
        tone === 'Formal'
          ? 'Could you please share a few times that work well with your schedule this week?'
          : tone === 'Friendly'
          ? 'Let me know a day or time that works best for you!'
          : 'Would you be open to a quick 15-minute call later this week?'
      break
    case 'followup':
      subjectPrefix = tone === 'Formal' ? 'Follow-Up:' : 'Following up:'
      bodyCore =
        tone === 'Formal'
          ? `I am following up regarding ${actionClause} I wanted to ensure you had everything needed on your end and see if any additional context would be helpful.`
          : `Just circling back on ${actionClause} Wanted to check in and see if you had any questions or thoughts since we last connected.`
      cta =
        tone === 'Formal'
          ? 'Please let me know how you would like to proceed at your convenience.'
          : 'Happy to jump on a quick call or continue over email—whichever is easier for you.'
      break
    case 'partnership':
      subjectPrefix = tone === 'Formal' ? 'Partnership Inquiry:' : 'Collaboration:'
      bodyCore =
        tone === 'Formal'
          ? `I am reaching out to explore a potential collaboration${companyRef} centered around ${actionClause} I see strong alignment between our teams and would welcome the opportunity to discuss how we might work together.`
          : `I've been following your work${companyRef} and wanted to explore collaborating on ${actionClause} I think there's a great opportunity for us to create value together.`
      cta =
        tone === 'Formal'
          ? 'Would you be available for a brief introductory call next week to explore this further?'
          : 'Would you be open to a quick chat to bounce a few ideas around?'
      break
    case 'application':
      subjectPrefix = tone === 'Formal' ? 'Application:' : 'Re:'
      bodyCore =
        tone === 'Formal'
          ? `I am writing to express my strong interest regarding ${actionClause} With my background and hands-on experience, I am confident I can contribute meaningfully to your team${companyRef}.`
          : `I'm reaching out regarding ${actionClause} I'm excited about what your team${companyRef} is building and would love to share how my experience aligns.`
      cta =
        tone === 'Formal'
          ? 'Thank you for your time and consideration. I would welcome the opportunity to speak further.'
          : 'Let me know if there is a convenient time for a brief introductory conversation.'
      break
    case 'invitation':
      subjectPrefix = tone === 'Formal' ? 'Invitation:' : "You're invited:"
      bodyCore =
        tone === 'Formal'
          ? `You are warmly invited regarding ${actionClause} Your perspective${companyRef} would add tremendous value to the conversation.`
          : `I wanted to personally invite you to ${actionClause} We'd be thrilled to have you join us.`
      cta =
        tone === 'Formal'
          ? 'Kindly let me know if you will be able to attend so we may reserve your place.'
          : 'Let me know if you can make it and I will send over the details!'
      break
    case 'thankyou':
      subjectPrefix = tone === 'Formal' ? 'Thank You:' : 'Thanks so much —'
      bodyCore =
        tone === 'Formal'
          ? `Thank you sincerely regarding ${actionClause} Your time, support, and insights${companyRef} are deeply appreciated.`
          : `Wanted to send a quick thank-you for ${actionClause} Really appreciate your time and help!`
      cta =
        tone === 'Formal'
          ? 'Please do not hesitate to reach out if I can ever be of assistance.'
          : 'Looking forward to staying in touch!'
      break
    case 'sales':
      subjectPrefix = tone === 'Formal' ? 'Introduction:' : 'Quick idea:'
      bodyCore =
        tone === 'Formal'
          ? `I am reaching out to introduce our work${companyRef ? ` to your team at ${company}` : ''} regarding ${actionClause} Our focus is helping teams streamline execution and achieve measurable results.`
          : `I wanted to reach out${companyRef ? ` to the ${company} team` : ''} regarding ${actionClause} We help teams move faster without adding operational overhead, and I'd love to share a tailored walkthrough.`
      cta =
        tone === 'Formal'
          ? 'Would you be available for a brief 15-minute introduction this week?'
          : 'Open to a quick 15-minute look sometime this week?'
      break
    case 'update':
      subjectPrefix = tone === 'Formal' ? 'Status Update:' : 'Update:'
      bodyCore =
        tone === 'Formal'
          ? `I am writing to share an important update regarding ${actionClause} Everything is progressing on track, and I wanted to keep you informed of the latest milestones.`
          : `Sharing a quick update on ${actionClause} Wanted to make sure you have the latest details and alignment on next steps.`
      cta =
        tone === 'Formal'
          ? 'Please let me know if you have any questions or require further details.'
          : 'Let me know if you have any questions or feedback!'
      break
    default:
      bodyCore =
        tone === 'Formal'
          ? `I am writing to reach out regarding the following matter: ${actionSentence} I believe aligning on this${companyRef} would be very worthwhile.`
          : tone === 'Friendly'
          ? `I wanted to reach out about ${actionClause} I think it would be great to connect and explore how we can move this forward.`
          : `I'm reaching out regarding ${actionClause} I'd appreciate the chance to connect and share a bit more context.`
      cta =
        tone === 'Formal'
          ? 'Please let me know if there is a convenient time for a brief conversation this week.'
          : tone === 'Friendly'
          ? 'Let me know what works best for you!'
          : 'Would you be open to a quick chat later this week?'
  }

  const subject = `${subjectPrefix} ${topicTitle}`
  const opening = openingByTone[tone] || openingByTone['Semi-Formal']
  const signoff = signoffByTone[tone] || signoffByTone['Semi-Formal']
  const body = `${opening}\n\n${bodyCore}\n\n${cta}\n\n${signoff}`

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
        title: 'Synthesize Context-Aware Draft',
        description: `Crafted a ${tone.toLowerCase()} ${intent} outreach draft tailored to "${conciseTopic}".`,
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
        description: 'Ready for one-click review, optional editing, and dispatch via Brevo.',
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

async function fetchGeminiGenerateContent({ endpoint, systemPrompt }) {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, GEMINI_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: 'application/json',
        },
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

  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i]
    attemptedModels.push(model)
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`

    try {
      const data = await fetchGeminiGenerateContent({
        endpoint,
        systemPrompt,
      })

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
      const hasMoreModels = i < GEMINI_MODELS.length - 1
      if (hasMoreModels) {
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
        engine: 'Smart Fallback Draft Engine',
        note: 'Gemini API unavailable; automatically generated draft with Smart Fallback Draft Engine.',
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
        draftEngine: 'Smart Fallback Draft Engine',
      },
      trace,
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
