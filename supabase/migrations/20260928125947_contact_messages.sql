-- Blava City: the main menu's "Napísať nám" form (src/ui/ContactUi.ts → supabase/functions/contact).
-- Applied with the Supabase CLI: `npx supabase db push`. Idempotent (re-running is harmless).
--
-- Every message is kept here as well as e-mailed, so nothing is lost when the e-mail fails, and the
-- edge function counts recent rows to rate-limit a sender. No browser can read or write this table:
-- only the edge function (a direct Postgres connection) touches it.
create table if not exists public.contact_messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- optional: where to reply; the e-mail goes out with this as Reply-To
  email text,
  nick text,
  message text not null,
  -- who sent it: played online or not, with an account or not, the page, the browser (never the IP)
  context jsonb not null default '{}'::jsonb,
  -- sha-256 of the sender's IP and a salt, for the rate limit only
  ip_hash text not null,
  emailed boolean not null default false
);
alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from anon, authenticated;
create index if not exists contact_messages_ip_recent on public.contact_messages (ip_hash, created_at desc);
create index if not exists contact_messages_recent on public.contact_messages (created_at desc);
