# MailPilot — Autonomous AI Email Outreach Agent

MailPilot is a Human-in-the-Loop (HITL) AI Email Outreach Agent built with **React**, **Vite**, **Tailwind CSS**, **Supabase Auth & Postgres**, **Google Gemini (`gemini-2.5-flash` / `gemini-2.0-flash`)**, and **Brevo SMTP API**.

## Features

- **Supabase Authentication**:
  - Email + Password (Sign In / Sign Up)
- **Autonomous Planning & Risk Classification**:
  - Validates target email and classifies risk (`HIGH` for external recipients, `MEDIUM` for self-test).
  - Generates a live 5-step execution plan and tailored draft via `gemini-2.5-flash` (with `gemini-2.0-flash` backup and a client-side Smart Fallback Draft Engine).
  - Persists run state in `agent_runs` and pauses at the Human-in-the-Loop approval gate.
- **Human-in-the-Loop Approval Gate & Tool Trace**:
  - Edit Recipient, Subject, and Email Body before sending.
  - **Approve & Send Email**: Sends via Brevo REST API, logs an audit entry in `email_logs`, and marks the run `completed`.
  - **Reject Draft**: Halts dispatch and marks the run `rejected`.
  - Collapsible **Agent Tool Trace** timeline with tool inputs, outputs, and execution durations in ms.
- **Audit History Tab**:
  - View past `agent_runs` and `email_logs` with status pills, timestamps, and full trace/email inspection.

## Setup

1. Ensure your `.env` file is populated at the project root.
2. Run `supabase/schema.sql` in your Supabase SQL Editor to create the `agent_runs` and `email_logs` tables along with Row Level Security (RLS) policies.
3. Install dependencies and start the frontend dev server:

```bash
npm install
npm run dev
```

## Lightweight Backend (`server/`) & Render Deployment

MailPilot includes a standalone Express + CORS Node.js backend in `server/index.js`:

- `GET /health` — Health & configuration check
- `POST /api/draft` — Validates recipient, classifies risk, generates a 5-step plan + email draft via Gemini (with automatic Smart Fallback Draft Engine if Gemini is unavailable)
- `POST /api/send` — Dispatches approved emails via Brevo SMTP REST API

Run locally:

```bash
cd server
npm install
npm start
```

Or from the project root:

```bash
npm run start:server
```

Deploy to Render using the included `render.yaml` Blueprint (`rootDir: server`, `healthCheckPath: /health`). Set `GEMINI_API_KEY`, `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, and `CORS_ORIGIN` in Render's environment settings.
