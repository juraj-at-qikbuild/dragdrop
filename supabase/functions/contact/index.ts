// The main menu's "Napísať nám" form (src/ui/ContactUi.ts): stores the message in
// public.contact_messages, then e-mails it through Resend from the verified gta-sk.fun domain.
// Deployed with verify_jwt off (supabase/config.toml [functions.contact]): guests have no JWT. Abuse
// is kept down by the origin check, a honeypot field, length limits and per-IP / global rate limits
// counted from the table.
//
// Secrets (`npx supabase secrets set NAME=value`):
//   RESEND_API_KEY  a Resend key allowed to send from gta-sk.fun
//   CONTACT_TO      where the messages go
// SUPABASE_DB_URL is provided by the platform.
import postgres from 'npm:postgres@3.4.5';

const FROM = 'GTA SK <kontakt@gta-sk.fun>';
const ORIGINS = new Set(['https://gta-sk.fun', 'https://www.gta-sk.fun', 'https://blava-city.juraj-4a0.workers.dev']);
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const MESSAGE_MIN = 5;
const MESSAGE_MAX = 4000;
const EMAIL_MAX = 200;
const NICK_MAX = 32;
/** per sender (IP) per hour, and for everyone per day */
const PER_IP_HOUR = 5;
const ALL_PER_DAY = 200;

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });

function cors(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    Vary: 'Origin',
  };
}

function reply(status: number, body: Record<string, unknown>, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** one line: no header injection through the subject */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ');

async function ipHash(req: Request): Promise<string> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  const salt = Deno.env.get('CONTACT_SALT') ?? 'blava-city-contact';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ip));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const allowed = !origin || ORIGINS.has(origin) || LOCAL.test(origin);
  if (!allowed) return new Response('forbidden', { status: 403 });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return reply(405, { error: 'method' }, origin);
  try {
    return await handle(req, origin);
  } catch (e) {
    console.error('contact:', e);
    return reply(500, { error: 'server' }, origin);
  }
});

async function handle(req: Request, origin: string | null): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'invalid' }, origin);
  }
  // the honeypot: a field people never see; a bot that fills it gets a quiet "sent"
  if (str(body.website, 200)) return reply(200, { ok: true }, origin);

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const email = str(body.email, EMAIL_MAX);
  const nick = oneLine(str(body.nick, NICK_MAX));
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) return reply(400, { error: 'message' }, origin);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: 'email' }, origin);
  const raw = body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : {};
  const context = {
    playedOnline: raw.playedOnline === true,
    account: raw.account === true,
    page: str(raw.page, 300),
    ua: str(req.headers.get('user-agent'), 300),
  };

  const hash = await ipHash(req);
  const [{ mine, total }] = await sql<{ mine: number; total: number }[]>`
    select
      count(*) filter (where ip_hash = ${hash} and created_at > now() - interval '1 hour')::int as mine,
      count(*)::int as total
    from public.contact_messages
    where created_at > now() - interval '1 day'`;
  if (mine >= PER_IP_HOUR || total >= ALL_PER_DAY) return reply(429, { error: 'rate' }, origin);

  const [{ id }] = await sql<{ id: number }[]>`
    insert into public.contact_messages (email, nick, message, context, ip_hash)
    values (${email || null}, ${nick || null}, ${message}, ${sql.json(context)}, ${hash})
    returning id`;

  // the message is saved either way: without the secrets it waits in the table (emailed = false)
  const to = Deno.env.get('CONTACT_TO');
  const key = Deno.env.get('RESEND_API_KEY');
  if (!to || !key) {
    console.error('contact: RESEND_API_KEY or CONTACT_TO is not set');
    return reply(200, { ok: true }, origin);
  }

  const text = [
    message,
    '',
    '—',
    `Prezývka: ${nick || '(žiadna)'}`,
    `E-mail: ${email || '(nevyplnený)'}`,
    `Hral online: ${context.playedOnline ? 'áno' : 'nie'}${context.account ? ', s účtom' : ''}`,
    `Stránka: ${context.page || '?'}`,
    `Prehliadač: ${context.ua || '?'}`,
    `Správa #${id}`,
  ].join('\n');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: `GTA SK – správa od ${nick || 'hráča'}`,
      text,
      ...(email ? { reply_to: email } : {}),
    }),
  });
  if (!res.ok) {
    // saved (emailed = false), so the player isn't asked to send it again
    console.error('contact: resend', res.status, await res.text());
    return reply(200, { ok: true }, origin);
  }
  await sql`update public.contact_messages set emailed = true where id = ${id}`;
  return reply(200, { ok: true }, origin);
}
