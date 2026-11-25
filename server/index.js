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
      process.env.BREVO_SENDER_EMAIL ||
      process.env.VITE_BREVO_SENDER_EMAIL ||
      'ramabhanta6@gmail.com',
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

function normalizeAndCorrectGoal(rawGoal) {
  let text = (rawGoal || '').replace(/\s+/g, ' ').trim()

  text = text
    .replace(
      /^(please\s+)?(can you\s+|could you\s+)?(write|draft|compose|send|create|generate)\s+(an?\s+)?(short\s+|quick\s+|brief\s+|formal\s+|semi-?formal\s+|friendly\s+)?(email|mail|message|note|letter|application|outreach)\s+(to\s+(?:my\s+)?[a-z]+(?:\s+[a-z]+)?\s+)?(about|regarding|for|asking|inviting|introducing|requesting|following up on)?\s*/i,
      ''
    )
    .trim()

  const typoReplacements = [
    [/\b(marrage|marraige|marrige|mariage|marige)\b/gi, 'marriage'],
    [/\b(weding|weddng|weeding)\b/gi, 'wedding'],
    [/\b(leav|leavs|leeve)\b/gi, 'leave'],
    [/\b(tommorow|tomorow|tommorw|tmrw|tmw|2moro)\b/gi, 'tomorrow'],
    [/\b(yestarday|yestrday)\b/gi, 'yesterday'],
    [/\b(plz|pls|plzz)\b/gi, 'please'],
    [/\b(bday|b'day)\b/gi, 'birthday'],
    [/\b(bcz|bcuz|coz|becuase|becoz)\b/gi, 'because'],
    [/\b(abt|abaut)\b/gi, 'about'],
    [/\b(msg|mssg)\b/gi, 'message'],
    [/\b(wrk)\b/gi, 'work'],
    [/\b(recieve|receve)\b/gi, 'receive'],
    [/\b(seperate)\b/gi, 'separate'],
    [/\b(occassion|ocasion)\b/gi, 'occasion'],
    [/\b(vacaton|vaction)\b/gi, 'vacation'],
    [/\b(clg|colg)\b/gi, 'college'],
    [/\b(univ)\b/gi, 'university'],
    [/\b(prof)\b/gi, 'professor'],
    [/\b(mgr)\b/gi, 'manager'],
    [/\b(bro)\b/gi, 'brother'],
    [/\b(sis)\b/gi, 'sister'],
    [/\b(famlily|famly|familly)\b/gi, 'family'],
    [/\b(functn|funtion)\b/gi, 'function'],
    [/\b(emergncy|emrgency)\b/gi, 'emergency'],
    [/\b(fevr)\b/gi, 'fever'],
    [/\b(hospitl|hosptal)\b/gi, 'hospital'],
    [/\b(meetng|meting)\b/gi, 'meeting'],
    [/\b(discus)\b/gi, 'discuss'],
    [/\b(appoinment|apointment)\b/gi, 'appointment'],
    [/\b(sry|srry)\b/gi, 'sorry'],
    [/\b(thx|thnx|tq|tnx)\b/gi, 'thank you'],
    [/\bu\b/gi, 'you'],
    [/\bur\b/gi, 'your'],
    [/\bi\b/g, 'I'],
    [/\bim\b/gi, "I'm"],
    [/\bi'm\b/gi, "I'm"],
    [/\bive\b/gi, "I've"],
    [/\bdont\b/gi, "don't"],
    [/\bcant\b/gi, "can't"],
    [/\bwont\b/gi, "won't"],
    [/\b(brother)\s+(marriage|wedding)\b/gi, "brother's wedding"],
    [/\b(sister)\s+(marriage|wedding)\b/gi, "sister's wedding"],
    [/\b(cousin)\s+(marriage|wedding)\b/gi, "cousin's wedding"],
    [/\b(friend)\s+(marriage|wedding)\b/gi, "friend's wedding"],
  ]

  for (const [pattern, replacement] of typoReplacements) {
    text = text.replace(pattern, replacement)
  }

  text = text.replace(/\b(\w+)\s+\1\b/gi, '$1')
  return text.replace(/\s+/g, ' ').trim()
}

function detectOutreachIntent(goal) {
  const text = goal.toLowerCase()
  if (
    /\b(leave|day off|days off|time off|pto|absent|absence|vacation|sick|fever|unwell|illness|hospital|medical|maternity|paternity|bereavement|half[\s-]?day|off work)\b/.test(
      text
    ) ||
    (/\b(marriage|wedding|ceremony|family function)\b/.test(text) &&
      /\b(want|need|take|taking|off|leave|days?|permission)\b/.test(text))
  ) {
    return 'leave'
  }
  if (/\b(thank|appreciate|grateful|gratitude)\b/.test(text)) return 'thankyou'
  if (/\b(follow[\s-]?up|checking in|circle back|touch base|reminder)\b/.test(text))
    return 'followup'
  if (
    /\b(apply|application|job|role|position|resume|cv|interview|internship|referral)\b/.test(
      text
    )
  ) {
    return 'application'
  }
  if (
    /\b(invite|invitation|party|celebration|webinar|event|workshop|meetup|conference|dinner|lunch|coffee)\b/.test(
      text
    )
  ) {
    return 'invitation'
  }
  if (/\b(partner|partnership|collaborat|joint|integrate|co-market)\b/.test(text))
    return 'partnership'
  if (
    /\b(demo|meeting|call|schedule|calendar|slot|15-min|30-min|chat|sync|catch up|appointment)\b/.test(
      text
    )
  ) {
    return 'meeting'
  }
  if (
    /\b(introduc|pitch|product|platform|solution|offer|service|proposal|pricing|trial)\b/.test(
      text
    )
  ) {
    return 'sales'
  }
  if (/\b(update|status|progress|report|launch|release|announcement)\b/.test(text))
    return 'update'
  return 'general'
}

function extractLeaveDetails(cleanedGoal) {
  const durationMatch = cleanedGoal.match(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few)\s+(days?|weeks?|months?)\b/i
  )
  const halfDayMatch = /\bhalf[\s-]?day\b/i.test(cleanedGoal)
  const duration = durationMatch
    ? `${durationMatch[1].toLowerCase()} ${durationMatch[2].toLowerCase()}`
    : halfDayMatch
    ? 'half a day'
    : ''

  const dateMatch = cleanedGoal.match(
    /\b(from\s+[a-z0-9,\s]+?(?:\s+to\s+[a-z0-9,\s]+)?|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|[a-z]+\s+\d{1,2})|starting\s+(?:tomorrow|monday|tuesday|wednesday|thursday|friday|next week)|tomorrow|next week|this week)\b/i
  )
  const datePhrase = dateMatch ? dateMatch[0].trim() : ''

  let reason = ''
  if (/brother'?s\s+(wedding|marriage)/i.test(cleanedGoal)) {
    reason = "my brother's wedding"
  } else if (/sister'?s\s+(wedding|marriage)/i.test(cleanedGoal)) {
    reason = "my sister's wedding"
  } else if (/cousin'?s\s+(wedding|marriage)/i.test(cleanedGoal)) {
    reason = "my cousin's wedding"
  } else if (/friend'?s\s+(wedding|marriage)/i.test(cleanedGoal)) {
    reason = "a close friend's wedding"
  } else if (/\b(wedding|marriage)\b/i.test(cleanedGoal)) {
    reason = 'a family wedding'
  } else if (/\b(sick|fever|unwell|ill|flu|cold|hospital|medical|doctor)\b/i.test(cleanedGoal)) {
    reason = 'medical'
  } else if (/\b(family emergency|emergency)\b/i.test(cleanedGoal)) {
    reason = 'an urgent family matter'
  } else if (/\b(family function|family event)\b/i.test(cleanedGoal)) {
    reason = 'a family event'
  } else if (/\bvacation\b/i.test(cleanedGoal)) {
    reason = 'a planned vacation'
  } else {
    const forMatch = cleanedGoal.match(/\b(?:for|due to|because of)\s+([^,.!?]+)/i)
    if (forMatch && !/\bleave\b/i.test(forMatch[1])) {
      reason = forMatch[1].trim()
    }
  }

  return { duration, datePhrase, reason }
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
  const cleanedAction = normalizeAndCorrectGoal(goal) || (goal || '').trim()
  const intent = detectOutreachIntent(cleanedAction)

  const topicBase = cleanedAction.replace(/[.!?]+$/, '')
  const conciseTopic =
    topicBase.length > 60
      ? `${topicBase.slice(0, 57).replace(/[,:;.\s]+$/, '')}...`
      : topicBase
  const topicTitle = capitalizeSentence(conciseTopic)

  const actionClause =
    cleanedAction.charAt(0).toLowerCase() + cleanedAction.slice(1).replace(/[.!?]+$/, '')
  const actionSentence = ensurePeriod(capitalizeSentence(cleanedAction))
  const companyRef = company ? ` at ${company}` : ''
  const emailFooter = senderEmail ? `\n${senderEmail}` : ''

  const greeting =
    tone === 'Formal'
      ? `Dear ${greetingName},`
      : tone === 'Friendly'
      ? `Hey ${greetingName}!`
      : `Hi ${greetingName},`

  const signoff =
    tone === 'Formal'
      ? `Sincerely,\n${senderName}${emailFooter}`
      : tone === 'Friendly'
      ? `Warmly,\n${senderName}${emailFooter}`
      : `Best regards,\n${senderName}${emailFooter}`

  let subject = ''
  let paragraphs = []

  switch (intent) {
    case 'leave': {
      const { duration, datePhrase, reason } = extractLeaveDetails(cleanedAction)
      const dateSuffix = datePhrase ? ` (${datePhrase})` : ''
      const dateInline = datePhrase ? ` ${datePhrase}` : ''

      if (tone === 'Formal') {
        const formalReason =
          reason === 'medical'
            ? 'for medical reasons and recovery'
            : reason
            ? `to attend ${reason}`
            : 'due to personal commitments'
        subject = `Leave Application${duration ? ` – ${capitalizeSentence(duration)}` : ''}${reason && reason !== 'medical' ? ` (${capitalizeSentence(reason)})` : ''}`
        paragraphs = [
          `I am writing to formally request ${duration ? `${duration} of leave` : 'a leave of absence'}${dateInline} ${formalReason}.`,
          'I will ensure that all ongoing tasks and pending responsibilities are completed or handed over cleanly prior to my absence, and I will remain reachable in case of any urgent matters.',
          'Thank you for your time and consideration. I kindly await your approval.',
        ]
      } else if (tone === 'Friendly') {
        const friendlyReason =
          reason === 'medical'
            ? "because I'm feeling under the weather"
            : reason
            ? `for ${reason}`
            : 'for a quick personal break'
        subject = `Taking ${duration || 'a few days'} off${reason && reason !== 'medical' ? ` – ${capitalizeSentence(reason)}` : ''}!`
        paragraphs = [
          `Hope you're having an awesome week! Just wanted to drop a quick note to let you know I'm hoping to take ${duration || 'a few days'} off${dateInline} ${friendlyReason}.`,
          "I'll make sure everything on my plate is wrapped up or covered before I head out so nothing slows down, and I'll jump right back in once I'm back.",
          'Let me know if that works on your end!',
        ]
      } else {
        const semiReason =
          reason === 'medical'
            ? 'due to health reasons'
            : reason
            ? `to attend ${reason}`
            : 'for personal reasons'
        subject = `Leave Request: ${duration ? `${duration} off` : 'Time off'}${dateSuffix}`
        paragraphs = [
          `I hope you're doing well. I wanted to reach out and request ${duration ? `${duration} of leave` : 'some time off'}${dateInline} ${semiReason}.`,
          "I'll make sure my current responsibilities are caught up and smoothly covered before I step away. Please let me know if this works for you.",
        ]
      }
      break
    }

    case 'meeting': {
      if (tone === 'Formal') {
        subject = `Meeting Request: ${topicTitle}`
        paragraphs = [
          `I hope this message finds you well. I am writing to formally request a brief meeting regarding ${actionClause}.`,
          `Given your perspective${companyRef}, I believe a focused discussion would be highly productive. Could you please share a few times that suit your schedule this week?`,
          'Thank you for your time and consideration.',
        ]
      } else if (tone === 'Friendly') {
        subject = `Quick chat: ${topicTitle}`
        paragraphs = [
          `Hope your week is going great! I wanted to see if we could hop on a quick call about ${actionClause}.`,
          'Let me know what day or time works best for you — looking forward to catching up!',
        ]
      } else {
        subject = `Scheduling: ${topicTitle}`
        paragraphs = [
          `I hope you're doing well. I wanted to reach out about scheduling a brief conversation regarding ${actionClause}.`,
          'Please let me know if you have a 15-minute window that works for you this week.',
        ]
      }
      break
    }

    case 'followup': {
      if (tone === 'Formal') {
        subject = `Follow-Up: ${topicTitle}`
        paragraphs = [
          `I hope this message finds you well. I am writing to follow up regarding ${actionClause}.`,
          'Please let me know if you require any additional information from my end. Thank you for your time and consideration.',
        ]
      } else if (tone === 'Friendly') {
        subject = `Checking in: ${topicTitle}`
        paragraphs = [
          `Hope you're having a great week! Just wanted to quickly circle back on ${actionClause}.`,
          'No rush at all — let me know your thoughts whenever you get a chance!',
        ]
      } else {
        subject = `Following up: ${topicTitle}`
        paragraphs = [
          `I hope you're doing well. I wanted to follow up briefly regarding ${actionClause}.`,
          'Please let me know if you have any questions or if there is anything helpful I can share.',
        ]
      }
      break
    }

    case 'application': {
      if (tone === 'Formal') {
        subject = `Application: ${topicTitle}`
        paragraphs = [
          `I am writing to formally express my interest regarding ${actionClause}.`,
          `With my relevant background and commitment to excellence, I am confident in my ability to add immediate value to your team${companyRef}.`,
          'Thank you for your time and consideration. I would welcome the opportunity to discuss my candidacy further.',
        ]
      } else if (tone === 'Friendly') {
        subject = `Excited to connect: ${topicTitle}`
        paragraphs = [
          `Hope you're having an awesome week! I wanted to reach out about ${actionClause}.`,
          `I'm really excited about what your team${companyRef} is doing and would love to chat more about how I can contribute. Let me know what you think!`,
        ]
      } else {
        subject = `Regarding: ${topicTitle}`
        paragraphs = [
          `I hope you're doing well. I wanted to reach out regarding ${actionClause}.`,
          `I'd appreciate the chance to share a bit more about my background${companyRef} and discuss how I might contribute. Please let me know if a brief call works for you.`,
        ]
      }
      break
    }

    case 'invitation': {
      if (tone === 'Formal') {
        subject = `Formal Invitation: ${topicTitle}`
        paragraphs = [
          `I am pleased to extend a formal invitation regarding ${actionClause}.`,
          `Your presence${companyRef} would be greatly valued. Kindly let me know if you will be able to attend at your earliest convenience.`,
        ]
      } else if (tone === 'Friendly') {
        subject = `You're invited: ${topicTitle}!`
        paragraphs = [
          `Hope your week is going great! I wanted to personally invite you to ${actionClause}.`,
          "It would be awesome to have you there — let me know if you can make it and I'll send over the details!",
        ]
      } else {
        subject = `Invitation: ${topicTitle}`
        paragraphs = [
          `I hope you're doing well. I wanted to invite you regarding ${actionClause}.`,
          'Please let me know if you are available to join, and I will gladly share all the details.',
        ]
      }
      break
    }

    case 'thankyou': {
      if (tone === 'Formal') {
        subject = `Expression of Gratitude: ${topicTitle}`
        paragraphs = [
          `I am writing to extend my sincere gratitude regarding ${actionClause}.`,
          'Your support and time are deeply appreciated. Please do not hesitate to reach out if I may ever be of assistance.',
        ]
      } else if (tone === 'Friendly') {
        subject = `Big thank you — ${topicTitle}!`
        paragraphs = [
          `Hope you're having a wonderful week! Just wanted to send a warm thank-you note for ${actionClause}.`,
          'I genuinely appreciate your help and kindness — talk soon!',
        ]
      } else {
        subject = `Thank you: ${topicTitle}`
        paragraphs = [
          `I hope you're doing well. I wanted to send a quick note to thank you for ${actionClause}.`,
          'I really appreciate your time and support. Best wishes ahead!',
        ]
      }
      break
    }

    case 'partnership':
    case 'sales': {
      if (tone === 'Formal') {
        subject = `${intent === 'partnership' ? 'Partnership Proposal' : 'Introduction'}: ${topicTitle}`
        paragraphs = [
          `I hope this message finds you well. I am writing to formally introduce an opportunity${companyRef} regarding ${actionClause}.`,
          'I believe our teams could achieve meaningful results together, and I would welcome a brief introductory discussion at your convenience.',
          'Thank you for your time and consideration.',
        ]
      } else if (tone === 'Friendly') {
        subject = `Quick idea: ${topicTitle}`
        paragraphs = [
          `Hope you're having an awesome week! Just wanted to drop a quick note about ${actionClause}.`,
          `I think there's a really exciting fit${companyRef ? ` with what you're doing at ${company}` : ''} — let me know what you think about hopping on a quick chat!`,
        ]
      } else {
        subject = `Connecting on: ${topicTitle}`
        paragraphs = [
          `I hope you're doing well. I wanted to reach out${companyRef} regarding ${actionClause}.`,
          "I'd love to share a quick overview and hear your thoughts. Please let me know if a brief conversation works for you this week.",
        ]
      }
      break
    }

    case 'update': {
      if (tone === 'Formal') {
        subject = `Status Update: ${topicTitle}`
        paragraphs = [
          `I am writing to provide a formal update regarding ${actionClause}.`,
          'Please let me know if you require any further clarification or documentation. Thank you for your time and attention.',
        ]
      } else if (tone === 'Friendly') {
        subject = `Quick update: ${topicTitle}`
        paragraphs = [
          `Hope your week is going well! Wanted to share a quick update on ${actionClause}.`,
          'Let me know if you have any questions or want to chat through any of the details!',
        ]
      } else {
        subject = `Update: ${topicTitle}`
        paragraphs = [
          `I hope you're doing well. I wanted to share a brief update regarding ${actionClause}.`,
          'Please let me know if you have any questions or feedback.',
        ]
      }
      break
    }

    default: {
      if (tone === 'Formal') {
        subject = `Regarding: ${topicTitle}`
        paragraphs = [
          `I hope this message finds you well. I am writing to formally reach out regarding the following matter: ${actionSentence}`,
          'Thank you for your time and consideration. Please let me know how you would like to proceed at your convenience.',
        ]
      } else if (tone === 'Friendly') {
        subject = `Quick note: ${topicTitle}`
        paragraphs = [
          `Hope you're having an awesome week! Just wanted to drop a quick note: ${actionSentence}`,
          'Let me know what you think!',
        ]
      } else {
        subject = `Regarding: ${topicTitle}`
        paragraphs = [
          `I hope you're doing well. I wanted to reach out regarding the following: ${actionSentence}`,
          'Please let me know if this works for you or if you have any questions.',
        ]
      }
    }
  }

  const body = `${greeting}\n\n${paragraphs.join('\n\n')}\n\n${signoff}`

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
        title: 'Normalize Grammar & Draft by Tone/Intent',
        description: `Drafted a ${tone.toLowerCase()} ${intent} email tailored to "${conciseTopic}".`,
        status: 'done',
      },
      {
        step: 3,
        title: 'Persist Run State',
        description: 'Checkpoint execution trace and draft payload.',
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
   - Step 2 must cover intent detection, grammar cleanup & tone calibration (${tone}).
   - Step 3 must cover drafting the personalized email & checkpointing state.
   - Step 4 must be the Human-in-the-Loop approval gate.
   - Step 5 must cover Brevo SMTP dispatch & audit logging.
2. A compelling, specific email subject line.
3. A clear, ready-to-send email body strictly written in the requested "${tone}" tone, signed off by "${cleanSenderName}"${cleanSenderEmail ? ` (${cleanSenderEmail})` : ''}.

CRITICAL WRITING & TONE RULES:
- Grammar & Spelling: ALWAYS fix typos, missing apostrophes, abbreviations, or broken grammar in the user's goal (e.g., "my brother marrage i want 3 days leave" -> "my brother's wedding" / "3 days of leave"). NEVER copy raw broken text verbatim.
- Intent Fidelity: Write a real, context-aware email for the specific intent (e.g., Leave Application, Event Invitation, Meeting Request, Job Application, Follow-Up, etc.). Never use generic corporate filler like "explore how we can move this forward".
- Strict Tone Differentiation:
  * If Tone is "Formal": Executive, respectful, and structured. Salutation: "Dear ...," Opening: "I am writing to formally..." Zero contractions or casual slang. Closing: "Thank you for your time and consideration." + "Sincerely,".
  * If Tone is "Semi-Formal": Polite, clear, approachable professional. Salutation: "Hi ...," Opening: "I hope you're doing well. I wanted to reach out regarding..." Closing: "Please let me know if this works for you." + "Best regards,".
  * If Tone is "Friendly": Warm, personal, conversational, and enthusiastic. Salutation: "Hey ...!" Opening: "Hope you're having an awesome week! Just wanted to drop a quick note about..." Closing: "Let me know what you think!" + "Warmly," or "Cheers,".
- Do not include placeholder brackets like [Your Name] or [Company].

Outreach Context:
- Sender Name: ${cleanSenderName}
- Sender Email: ${cleanSenderEmail || 'Not provided'}
- Recipient Email: ${cleanRecipient}
- Risk Level: ${riskResult.riskLevel}
- Tone: ${tone}
- Raw Goal / Purpose: ${cleanGoal}

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

  const loggedInEmail = (replyToEmail || senderEmail || brevo.senderEmail).trim()
  const senderDisplayName =
    senderName && senderName.trim() && senderName.trim() !== 'MailPilot User' && senderName.trim() !== loggedInEmail
      ? `${senderName.trim()} (${loggedInEmail})`
      : loggedInEmail
  const textContentWithFooter = appendOnBehalfFooter(cleanBody, loggedInEmail)
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
          name: senderDisplayName,
          email: brevo.senderEmail,
        },
        replyTo: {
          email: loggedInEmail,
          name: loggedInEmail,
        },
        to: [{ email: cleanRecipient }],
        subject: cleanSubject,
        textContent: textContentWithFooter,
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
