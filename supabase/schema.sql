-- MailPilot Supabase Schema & Row Level Security Policies
-- Run this in your Supabase Dashboard -> SQL Editor if the tables do not exist yet.

create extension if not exists "pgcrypto";

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sender_name text not null,
  sender_email text not null,
  goal text not null,
  status text not null default 'awaiting_approval'
    check (status in ('running', 'awaiting_approval', 'completed', 'rejected', 'failed')),
  plan jsonb not null default '[]'::jsonb,
  trace jsonb not null default '[]'::jsonb,
  draft_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  sender_name text not null,
  sender_email text not null,
  recipient_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'sent'
    check (status in ('sent', 'failed')),
  provider_message_id text,
  risk_level text,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_runs_user_created
  on public.agent_runs(user_id, created_at desc);

create index if not exists idx_email_logs_user_created
  on public.email_logs(user_id, created_at desc);

alter table public.agent_runs enable row level security;
alter table public.email_logs enable row level security;

-- RLS policies for agent_runs
drop policy if exists "Users can view their own agent runs" on public.agent_runs;
create policy "Users can view their own agent runs"
  on public.agent_runs for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own agent runs" on public.agent_runs;
create policy "Users can insert their own agent runs"
  on public.agent_runs for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own agent runs" on public.agent_runs;
create policy "Users can update their own agent runs"
  on public.agent_runs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- RLS policies for email_logs
drop policy if exists "Users can view their own email logs" on public.email_logs;
create policy "Users can view their own email logs"
  on public.email_logs for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own email logs" on public.email_logs;
create policy "Users can insert their own email logs"
  on public.email_logs for insert
  with check (auth.uid() = user_id);
