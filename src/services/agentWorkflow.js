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

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash']
const GEMINI_REQUEST_TIMEOUT_MS = 12000
const GEMINI_503_RETRY_DELAY_MS = 500

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

  const openingByTone = {
    Formal: `Dear ${greetingName},\n\nI hope this message finds you well.`,
    'Semi-Formal': `Hi ${greetingName},\n\nI hope you're doing well.`,
    Friendly: `Hi ${greetingName},\n\nHope your week is going great!`,
  }

  const signoffByTone = {
    Formal: `Sincerely,\n${senderName}\n${senderEmail}`,
    'Semi-Formal': `Best regards,\n${senderName}\n${senderEmail}`,
    Friendly: `Best,\n${senderName}\n${senderEmail}`,
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
      },
      {
        step: 2,
        title: 'Synthesize Context-Aware Draft',
        description: `Crafted a ${tone.toLowerCase()} ${intent} outreach draft tailored to "${conciseTopic}".`,
      },
      {
        step: 3,
        title: 'Checkpoint Run & Stage Draft',
        description: 'Prepare execution trace and stage draft for operator review.',
      },
      {
        step: 4,
        title: 'Human-in-the-Loop Approval Gate',
        description: 'Ready for one-click review, optional editing, and dispatch via Brevo.',
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

      const detailedError = new Error(formatGeminiError(attemptErrors))
      detailedError.attemptedModels = attemptedModels
      detailedError.attemptErrors = attemptErrors
      detailedError.status = err.status
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
    if (!geminiKey) {
      throw new Error('VITE_GEMINI_API_KEY is not configured; using Smart Fallback Draft Engine.')
    }

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

    geminiResult = buildFallbackDraftPlan({
      senderName,
      senderEmail,
      recipientEmail: cleanRecipient,
      goal: cleanGoal,
      tone,
      riskResult,
    })
    draftEngine = 'Smart Fallback Draft Engine'

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
        engine: 'Smart Fallback Draft Engine',
        note: 'Gemini API unavailable; automatically generated draft with Smart Fallback Draft Engine.',
        fallbackUsed: true,
        attemptedModels: err.attemptedModels || GEMINI_MODELS,
        attemptErrors: err.attemptErrors || [err.message],
        subject: geminiResult.subject,
        bodyLength: geminiResult.body.length,
        planStepsGenerated: plan.length,
      },
    })
    emit('running')
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
    // Gracefully continue with an in-memory run so the user can still review & send via Brevo
    const t3Duration = Math.max(1, Math.round(performance.now() - t3Start))
    prePersistTraceEntry.durationMs = t3Duration
    prePersistTraceEntry.status = 'error'
    prePersistTraceEntry.outputs = {
      checkpointStatus: 'awaiting_approval (local session)',
      warning: err.message,
    }

    const localRun = {
      id: null,
      isLocalFallbackRun: true,
      user_id: user.id,
      sender_name: senderName,
      sender_email: senderEmail,
      goal: cleanGoal,
      status: 'awaiting_approval',
      plan,
      trace: [...trace, prePersistTraceEntry, gateTraceEntry],
      draft_payload: draftPayload,
      created_at: new Date().toISOString(),
    }

    emit('awaiting_approval', draftPayload)
    return localRun
  }
}

function appendOnBehalfFooter(body, userEmail) {
  const clean = (body || '').trim()
  if (!userEmail) return clean
  if (clean.toLowerCase().includes('on behalf of') && clean.includes(userEmail)) {
    return clean
  }
  return `${clean}\n\n---\nSent via MailPilot on behalf of ${userEmail}. Replies to this email will go directly to ${userEmail}.`
}

export async function approveAndSendEmail({
  run,
  user,
  recipientEmail,
  subject,
  body,
}) {
  const brevoApiKey = import.meta.env.VITE_BREVO_API_KEY
  const brevoSenderEmail =
    import.meta.env.VITE_BREVO_SENDER_EMAIL || 'ramabhanta6@gmail.com'

  if (!brevoApiKey) {
    throw new Error('Missing VITE_BREVO_API_KEY in .env.')
  }

  const cleanRecipient = recipientEmail.trim()
  const cleanSubject = subject.trim()
  const cleanBody = body.trim()

  const riskResult = classifyRisk(cleanRecipient, user.email)
  if (!cleanSubject || !cleanBody) {
    throw new Error('Subject and email body cannot be empty.')
  }

  const loggedInEmail = (user?.email || run.sender_email || brevoSenderEmail).trim()
  const metaName = (
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    ''
  ).trim()
  const senderDisplayName = metaName
    ? `${metaName} (${loggedInEmail})`
    : loggedInEmail
  const senderName = run.sender_name || deriveSenderName(user)
  const senderEmail = loggedInEmail
  const textContentWithFooter = appendOnBehalfFooter(cleanBody, loggedInEmail)

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
          name: senderDisplayName,
          email: brevoSenderEmail,
        },
        replyTo: {
          email: loggedInEmail,
          name: loggedInEmail,
        },
        to: [
          {
            email: cleanRecipient,
          },
        ],
        subject: cleanSubject,
        textContent: textContentWithFooter,
      }),
    })

    brevoData = await brevoRes.json().catch(() => ({}))
    if (!brevoRes.ok) {
      const msg =
        brevoData?.message ||
        brevoData?.code ||
        `Brevo API returned HTTP ${brevoRes.status}`
      throw new Error(`Brevo API (${brevoRes.status}): ${msg}`)
    }
  } catch (err) {
    const cleanErrorMsg = isNetworkFailure(err)
      ? `Brevo API network error (${err.name ? `${err.name}: ` : ''}${err.message || 'request failed'})`
      : err.message || 'Brevo email dispatch failed.'
    const brevoDuration = Math.max(1, Math.round(performance.now() - brevoStart))
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
          sender: `${senderDisplayName} <${brevoSenderEmail}>`,
          replyTo: `${loggedInEmail} <${loggedInEmail}>`,
          to: cleanRecipient,
          subject: cleanSubject,
        },
        outputs: { error: cleanErrorMsg },
      },
    ]

    if (run.id) {
      await supabase
        .from('email_logs')
        .insert({
          user_id: user.id,
          run_id: run.id,
          sender_name: senderName,
          sender_email: senderEmail,
          recipient_email: cleanRecipient,
          subject: cleanSubject,
          body: textContentWithFooter,
          status: 'failed',
          provider_message_id: null,
          risk_level: riskResult.riskLevel,
        })
        .catch(() => {})

      // Keep run in awaiting_approval so the operator can adjust and retry in one click
      await supabase
        .from('agent_runs')
        .update({
          trace: failedTrace,
          draft_payload: updatedDraftPayload,
          updated_at: new Date().toISOString(),
        })
        .eq('id', run.id)
        .catch(() => {})
    }

    const brevoErr = new Error(cleanErrorMsg)
    brevoErr.updatedTrace = failedTrace
    brevoErr.updatedDraftPayload = updatedDraftPayload
    throw brevoErr
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
      sender: `${senderDisplayName} <${brevoSenderEmail}>`,
      replyTo: `${loggedInEmail} <${loggedInEmail}>`,
      to: cleanRecipient,
      subject: cleanSubject,
    },
    outputs: {
      messageId,
      provider: 'brevo',
      delivered: true,
    },
  }

  // Insert audit record into email_logs (best-effort if DB table isn't provisioned)
  const logStart = performance.now()
  let emailLog = null
  let logTraceEntry
  try {
    const { data: insertedLog, error: logError } = await supabase
      .from('email_logs')
      .insert({
        user_id: user.id,
        run_id: run.id || null,
        sender_name: senderName,
        sender_email: senderEmail,
        recipient_email: cleanRecipient,
        subject: cleanSubject,
        body: textContentWithFooter,
        status: 'sent',
        provider_message_id: messageId,
        risk_level: riskResult.riskLevel,
      })
      .select()
      .single()

    if (logError) throw new Error(logError.message)
    emailLog = insertedLog
    logTraceEntry = {
      id: `trace-${Date.now()}-6`,
      step: 5,
      tool: 'supabase_insert_email_log',
      status: 'success',
      durationMs: Math.max(1, Math.round(performance.now() - logStart)),
      timestamp: new Date().toISOString(),
      inputs: {
        table: 'email_logs',
        runId: run.id || null,
        recipientEmail: cleanRecipient,
      },
      outputs: {
        emailLogId: emailLog.id,
        status: 'sent',
        providerMessageId: messageId,
      },
    }
  } catch (logErr) {
    logTraceEntry = {
      id: `trace-${Date.now()}-6`,
      step: 5,
      tool: 'supabase_insert_email_log',
      status: 'error',
      durationMs: Math.max(1, Math.round(performance.now() - logStart)),
      timestamp: new Date().toISOString(),
      inputs: { table: 'email_logs', recipientEmail: cleanRecipient },
      outputs: {
        warning: `Email delivered via Brevo, but Supabase audit log failed: ${logErr.message}`,
      },
    }
  }

  const completedPlan = updatedPlan.map((stepObj) =>
    stepObj.step === 5 ? { ...stepObj, status: 'done' } : stepObj
  )
  const completedTrace = [...existingTrace, brevoTraceEntry, logTraceEntry]

  if (run.id) {
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

    if (!updateError && updatedRun) {
      return { updatedRun, emailLog, messageId }
    }
  }

  const fallbackCompletedRun = {
    ...run,
    status: 'completed',
    plan: completedPlan,
    trace: completedTrace,
    draft_payload: updatedDraftPayload,
    updated_at: new Date().toISOString(),
  }

  return { updatedRun: fallbackCompletedRun, emailLog, messageId }
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

  if (run.id) {
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

    if (!error && updatedRun) {
      return updatedRun
    }
  }

  return {
    ...run,
    status: 'rejected',
    plan: rejectedPlan,
    trace: rejectedTrace,
    draft_payload: draftPayload || run.draft_payload,
    updated_at: new Date().toISOString(),
  }
}
