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

function normalizeAndCorrectGoal(rawGoal) {
  let text = (rawGoal || '').replace(/\s+/g, ' ').trim()

  // Strip leading prompt-style meta instructions
  text = text
    .replace(
      /^(please\s+)?(can you\s+|could you\s+)?(write|draft|compose|send|create|generate)\s+(an?\s+)?(short\s+|quick\s+|brief\s+|formal\s+|semi-?formal\s+|friendly\s+)?(email|mail|message|note|letter|application|outreach)\s+(to\s+(?:my\s+)?[a-z]+(?:\s+[a-z]+)?\s+)?(about|regarding|for|asking|inviting|introducing|requesting|following up on)?\s*/i,
      ''
    )
    .trim()

  // Common typos, SMS shorthand, and grammar cleanups
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

  // Collapse duplicated consecutive words (e.g. "about about" -> "about")
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

  const greeting =
    tone === 'Formal'
      ? `Dear ${greetingName},`
      : tone === 'Friendly'
      ? `Hey ${greetingName}!`
      : `Hi ${greetingName},`

  const signoff =
    tone === 'Formal'
      ? `Sincerely,\n${senderName}\n${senderEmail}`
      : tone === 'Friendly'
      ? `Warmly,\n${senderName}\n${senderEmail}`
      : `Best regards,\n${senderName}\n${senderEmail}`

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
      },
      {
        step: 2,
        title: 'Normalize Grammar & Draft by Tone/Intent',
        description: `Drafted a ${tone.toLowerCase()} ${intent} email tailored to "${conciseTopic}".`,
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
   - Step 2 must cover intent detection, grammar cleanup & tone calibration (${tone}).
   - Step 3 must cover drafting the personalized email & checkpointing state.
   - Step 4 must be the Human-in-the-Loop approval gate.
   - Step 5 must cover Brevo SMTP dispatch & Supabase audit logging.
2. A compelling, specific email subject line.
3. A clear, ready-to-send email body strictly written in the requested "${tone}" tone, signed off by "${senderName}" (${senderEmail}).

CRITICAL WRITING & TONE RULES:
- Grammar & Spelling: ALWAYS fix typos, missing apostrophes, abbreviations, or broken grammar in the user's goal (e.g., "my brother marrage i want 3 days leave" -> "my brother's wedding" / "3 days of leave"). NEVER copy raw broken text verbatim.
- Intent Fidelity: Write a real, context-aware email for the specific intent (e.g., Leave Application, Event Invitation, Meeting Request, Job Application, Follow-Up, etc.). Never use generic corporate filler like "explore how we can move this forward".
- Strict Tone Differentiation:
  * If Tone is "Formal": Executive, respectful, and structured. Salutation: "Dear ...," Opening: "I am writing to formally..." Zero contractions or casual slang. Closing: "Thank you for your time and consideration." + "Sincerely,".
  * If Tone is "Semi-Formal": Polite, clear, approachable professional. Salutation: "Hi ...," Opening: "I hope you're doing well. I wanted to reach out regarding..." Closing: "Please let me know if this works for you." + "Best regards,".
  * If Tone is "Friendly": Warm, personal, conversational, and enthusiastic. Salutation: "Hey ...!" Opening: "Hope you're having an awesome week! Just wanted to drop a quick note about..." Closing: "Let me know what you think!" + "Warmly," or "Cheers,".
- Do not include placeholder brackets like [Your Name] or [Company].

Outreach Context:
- Sender Name: ${senderName}
- Sender Email: ${senderEmail}
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
