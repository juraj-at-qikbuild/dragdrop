// The main menu's "Napísať nám" form posts here: the Supabase Edge Function `contact`
// (supabase/functions/contact), which stores the message and e-mails it. Needs the same two env vars
// as accounts (src/net/auth.ts); without them `contactAvailable()` is false and the button stays hidden.
import { authAvailable } from './auth';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const TIMEOUT_MS = 15_000;

export const MESSAGE_MIN = 5;
export const MESSAGE_MAX = 4000;

export interface ContactMessage {
  message: string;
  email: string;
  nick: string;
  /** the hidden honeypot field: filled only by bots */
  website: string;
  context: { playedOnline: boolean; account: boolean; page: string };
}
export type ContactResult = { ok: true } | { ok: false; error: string };

export const contactAvailable = authAvailable;

const ERRORS: Record<string, string> = {
  message: `Správa musí mať ${MESSAGE_MIN}–${MESSAGE_MAX} znakov.`,
  email: 'Zadaj platný e-mail, alebo ho nechaj prázdny.',
  rate: 'Príliš veľa správ, skús to neskôr.',
};

export async function sendContact(msg: ContactMessage): Promise<ContactResult> {
  if (!contactAvailable()) return { ok: false, error: 'Odosielanie správ je teraz nedostupné.' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: PUBLISHABLE_KEY! },
      body: JSON.stringify(msg),
      signal: ctl.signal,
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: ERRORS[body.error ?? ''] ?? 'Správu sa nepodarilo odoslať, skús to znova.' };
  } catch {
    return { ok: false, error: 'Správu sa nepodarilo odoslať. Si pripojený na internet?' };
  } finally {
    clearTimeout(timer);
  }
}
