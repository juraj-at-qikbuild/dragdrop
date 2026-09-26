// Guest-or-Supabase-Auth UI (docs/plans/social-events.md, Features → Accounts): the "Ako chceš hrať?"
// chooser, sign-in/sign-up/reset forms, the pause menu's account controls, and the boot-time e-mail
// returns. Built entirely from src/ui/kit/dom.ts so it matches the existing #nick/#pause look; no
// index.html edits. `@supabase/auth-js` itself is never imported here — src/net/auth.ts stays the only
// place that touches it, so this module (and main.ts, which always loads it) costs guests nothing extra.
import type { Game } from '../game/Game';
import { addPauseControl, field, openModal, toast, type ModalButton } from './kit/dom';
import { cleanNick, NICK_MAX, NICK_MIN } from '../shared/net/protocol';
import { authAvailable, clearPendingPasswordReset, hasStoredSession, resetPassword, signIn, signOut, signUp, updatePassword, user } from '../net/auth';
import { clearPendingJoin, loadIdentity, newToken, saveIdentity, type Identity } from '../net/identity';
import { randomNick } from '../net/nicknames';
import { askNick } from './askNick';

declare global {
  interface Window {
    /** the voice feature calls this when a guest tries to opt in (voice is accounts-only) */
    openAccountModal?: () => void;
  }
}

const CLAIM_QUESTION = 'Preniesť tvoj doterajší postup (peniaze, objavené miesta) do účtu?';
const NICK_RULE = `${NICK_MIN}–${NICK_MAX} znakov: písmená, čísla, medzera, . _ -`;

// ---------------------------------------------------------------------------------------- small state
// A claim survives the reload that actually enters online mode (src/main.ts's onlineBoot), so it's
// kept in localStorage rather than a module variable: set right before we reload (after sign-up with
// an immediate session, or after confirming the account by e-mail), consumed exactly once by the
// fresh page's boot.
const CLAIM_KEY = 'blava-city-claim-pending';
function setClaimPending(v: boolean) {
  try {
    if (v) localStorage.setItem(CLAIM_KEY, '1');
    else localStorage.removeItem(CLAIM_KEY);
  } catch {
    /* ignore */
  }
}
/** reads and clears the flag; main.ts calls this once, right before sending hello.claim */
export function consumeClaimPending(): boolean {
  try {
    const v = localStorage.getItem(CLAIM_KEY) === '1';
    localStorage.removeItem(CLAIM_KEY);
    return v;
  } catch {
    return false;
  }
}

/** called right before the hash-set + reload that actually enters online mode (e.g. leaving the
 *  current online session first, when switching identity from the pause menu) */
let onBeforeReload: (() => void) | undefined;
function proceedOnline() {
  onBeforeReload?.();
  location.hash = 'online';
  location.reload();
}

/** The identity to connect with once online mode has (re)loaded: an account when signed in (rebuilt
 *  fresh each boot — Identity.account is never persisted, see src/net/identity.ts), else the guest
 *  identity. Downloads auth-js only when a stored session actually exists. */
export async function resolveOnlineIdentity(): Promise<Identity | null> {
  if (authAvailable() && hasStoredSession()) {
    const u = await user();
    if (u) {
      const guest = loadIdentity();
      return { token: guest?.token ?? newToken(), nick: u.nickname ?? guest?.nick ?? randomNick(), account: true };
    }
  }
  return loadIdentity();
}

// ------------------------------------------------------------------------------------------ helpers
function setBusy(el: HTMLElement, busy: boolean) {
  el.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = busy));
}
function makeError(): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'error hidden';
  return p;
}
function setError(el: HTMLParagraphElement, msg: string | null) {
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else el.classList.add('hidden');
}
function askYesNo(title: string, body: string, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) => {
    openModal({
      title,
      body,
      buttons: [
        { label: yes, primary: true, onClick: () => resolve(true) },
        { label: no, onClick: () => resolve(false) },
      ],
      onClose: () => resolve(false),
    });
  });
}

/** today's nickname prompt, for a device with no guest identity yet */
async function guestFlow(): Promise<void> {
  let id = loadIdentity();
  if (!id) {
    const nick = await askNick(randomNick(), 'Hrať online');
    if (!nick) return; // cancelled: stay put
    id = { token: newToken(), nick };
    saveIdentity(id);
  }
  proceedOnline();
}

// -------------------------------------------------------------------------------------------- forms
function showCheckEmail() {
  openModal({
    title: 'Skontroluj e-mail',
    body: 'Pozri si e-mail: poslali sme ti odkaz na potvrdenie účtu.',
    buttons: [{ label: 'OK', primary: true, onClick: () => {} }],
  });
}

function showSignIn(mode: ChooserMode) {
  const email = field('E-mail', { type: 'email', autocomplete: 'email', required: true });
  const password = field('Heslo', { type: 'password', autocomplete: 'current-password', required: true });
  const err = makeError();
  const forgot = document.createElement('button');
  forgot.type = 'button';
  forgot.className = 'kit-link';
  forgot.textContent = 'Zabudol si heslo?';
  forgot.onclick = async () => {
    const e = email.input.value.trim();
    if (!e.includes('@')) return setError(err, 'Zadaj platný e-mail.');
    forgot.disabled = true;
    const r = await resetPassword(e);
    forgot.disabled = false;
    if (r.ok) toast('Poslali sme ti e-mail na zmenu hesla.');
    else setError(err, r.error);
  };
  const body = document.createElement('div');
  body.append(email.el, password.el, forgot, err);
  const handle = openModal({
    title: 'Prihlásiť sa',
    body,
    buttons: [
      {
        label: 'Prihlásiť sa',
        primary: true,
        onClick: async () => {
          const e = email.input.value.trim(), p = password.input.value;
          if (!e.includes('@') || !p) {
            setError(err, 'Vyplň e-mail a heslo.');
            return false;
          }
          setBusy(handle.el, true);
          const r = await signIn(e, p);
          setBusy(handle.el, false);
          if (!r.ok) {
            setError(err, r.error);
            return false;
          }
          setClaimPending(false); // signing into an existing account never claims (see docs/plans)
          proceedOnline();
          return true;
        },
      },
      { label: 'Späť', onClick: () => showChooserModal(mode) },
    ],
  });
}

function showSignUp(mode: ChooserMode) {
  const email = field('E-mail', { type: 'email', autocomplete: 'email', required: true });
  const password = field('Heslo', { type: 'password', autocomplete: 'new-password', required: true, minLength: 8 });
  const nick = field('Prezývka', { maxLength: NICK_MAX, minLength: NICK_MIN });
  const hint = document.createElement('p');
  hint.className = 'hint small';
  hint.textContent = `Heslo: aspoň 8 znakov. Prezývka: ${NICK_RULE}`;
  const err = makeError();
  const body = document.createElement('div');
  body.append(email.el, password.el, nick.el, hint, err);
  const handle = openModal({
    title: 'Vytvoriť účet',
    body,
    buttons: [
      {
        label: 'Vytvoriť účet',
        primary: true,
        onClick: async () => {
          const e = email.input.value.trim(), p = password.input.value;
          const n = cleanNick(nick.input.value);
          if (!e.includes('@')) {
            setError(err, 'Zadaj platný e-mail.');
            return false;
          }
          if (p.length < 8) {
            setError(err, 'Heslo musí mať aspoň 8 znakov.');
            return false;
          }
          if (!n) {
            setError(err, `Prezývka: ${NICK_RULE}`);
            return false;
          }
          setBusy(handle.el, true);
          const r = await signUp(e, p, n);
          setBusy(handle.el, false);
          if (!r.ok) {
            setError(err, r.error);
            return false;
          }
          // "Confirm email" is on for this project, so there's normally no session yet; handled either
          // way so a project with confirmations off still works.
          if (hasStoredSession()) {
            if (loadIdentity()) setClaimPending(await askYesNo('Účet vytvorený!', CLAIM_QUESTION, 'Áno', 'Nie'));
            proceedOnline();
          } else {
            showCheckEmail();
          }
          return true;
        },
      },
      { label: 'Späť', onClick: () => showChooserModal(mode) },
    ],
  });
}

type ChooserMode = 'boot' | 'account';

function showChooserModal(mode: ChooserMode) {
  const body = document.createElement('div');
  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = mode === 'boot' ? 'Všetci hráči sú v jednej Bratislave. Ako chceš hrať?' : 'Vytvor si účet: postup na všetkých zariadeniach a hlasový chat.';
  body.appendChild(intro);
  // every button below leads onward (guest/sign-in/sign-up); only an outright close (Escape) without
  // picking one abandons the flow — see the boot chooser's onClose below
  let proceeded = false;
  const buttons: ModalButton[] = [];
  if (mode === 'boot') buttons.push({ label: 'Hrať ako hosť', primary: true, onClick: () => { proceeded = true; void guestFlow(); } });
  buttons.push({ label: 'Prihlásiť sa', primary: mode === 'account', onClick: () => { proceeded = true; showSignIn(mode); } });
  buttons.push({ label: 'Vytvoriť účet', onClick: () => { proceeded = true; showSignUp(mode); } });
  if (mode === 'account') buttons.push({ label: 'Zrušiť', onClick: () => {} });
  openModal({
    title: 'Ako chceš hrať?',
    body,
    buttons,
    onClose: () => {
      // a pending #join code (src/boot/links.ts) waits in sessionStorage for this device's identity
      // to resolve; if the boot chooser closes without picking a way to proceed, that join is
      // abandoned — clear it so it isn't silently resent on some later, unrelated online session
      if (mode === 'boot' && !proceeded) clearPendingJoin();
    },
  });
}

/** Opens the account chooser. 'boot' (default): the full picker, guest first — but only when there's
 *  something to choose: no accounts configured, or already signed in, skip straight through (so a
 *  #join link, or a returning guest/account, still starts in one click). 'account': no guest button,
 *  for a guest who explicitly wants to add an account (pause menu, or the voice feature). */
export function openChooser(opts: { mode?: ChooserMode; onBeforeReload?: () => void } = {}) {
  onBeforeReload = opts.onBeforeReload;
  const mode = opts.mode ?? 'boot';
  if (mode === 'boot') {
    if (hasStoredSession()) return proceedOnline(); // already signed in: nothing to ask
    if (!authAvailable()) return void guestFlow(); // accounts off entirely: today's plain flow
  }
  showChooserModal(mode);
}

// ------------------------------------------------------------------------------- boot-time e-mail returns
/** after a confirmed sign-up (main.ts's `authCallback` branch, signedIn true): offers to move this
 *  device's guest progress in (only if there is any — the server refuses into a non-empty account
 *  anyway), then reloads into #online as the account. */
export async function offerClaimAndGoOnline(): Promise<void> {
  if (loadIdentity()) setClaimPending(await askYesNo('Účet potvrdený!', CLAIM_QUESTION, 'Áno', 'Nie'));
  else {
    toast('Účet potvrdený!');
    setClaimPending(false);
  }
  proceedOnline();
}

/** the `reset` boot link, once handleAuthCallback() confirms a recovery session exists */
export function completePasswordReset(): Promise<void> {
  return new Promise((resolve) => {
    const p1 = field('Nové heslo', { type: 'password', autocomplete: 'new-password', minLength: 8 });
    const p2 = field('Zopakuj nové heslo', { type: 'password', autocomplete: 'new-password', minLength: 8 });
    const err = makeError();
    const body = document.createElement('div');
    body.append(p1.el, p2.el, err);
    const handle = openModal({
      title: 'Nové heslo',
      body,
      buttons: [
        {
          label: 'Uložiť heslo',
          primary: true,
          onClick: async () => {
            if (p1.input.value.length < 8) {
              setError(err, 'Heslo musí mať aspoň 8 znakov.');
              return false;
            }
            if (p1.input.value !== p2.input.value) {
              setError(err, 'Heslá sa nezhodujú.');
              return false;
            }
            setBusy(handle.el, true);
            const r = await updatePassword(p1.input.value);
            setBusy(handle.el, false);
            if (!r.ok) {
              setError(err, r.error);
              return false;
            }
            clearPendingPasswordReset();
            toast('Heslo zmenené.');
            resolve();
            return true;
          },
        },
      ],
      onClose: () => resolve(),
    });
  });
}

// ---------------------------------------------------------------------------------------- pause menu
let wired = false;

function openDeleteConfirm(game: Game) {
  const warn = document.createElement('p');
  warn.className = 'hint';
  warn.textContent = 'Toto natrvalo zmaže tvoj účet a všetok postup. Túto akciu nemožno vrátiť späť.';
  const confirmField = field('Napíš ZMAZAŤ pre potvrdenie');
  const body = document.createElement('div');
  body.append(warn, confirmField.el);
  const handle = openModal({
    title: 'Zmazať účet',
    body,
    buttons: [
      { label: 'Zmazať účet natrvalo', danger: true, onClick: () => game.online?.deleteAccount() },
      { label: 'Zrušiť', onClick: () => {} },
    ],
  });
  const dangerBtn = handle.el.querySelector<HTMLButtonElement>('.buttons button.danger');
  if (dangerBtn) {
    dangerBtn.disabled = true;
    confirmField.input.addEventListener('input', () => {
      dangerBtn.disabled = confirmField.input.value.trim() !== 'ZMAZAŤ';
    });
  }
}

/** Adds the pause menu's account section (once per page load — startOnline can retry, but this must
 *  land only once it actually succeeds). Signed in: nick/e-mail, sign out, delete. Guest: an "add an
 *  account" button, which also backs `window.openAccountModal` (the voice feature, for a guest). */
export async function wireAccountPauseControls(game: Game): Promise<void> {
  if (wired) return;
  wired = true;
  const openAccountMode = () => openChooser({ mode: 'account', onBeforeReload: () => game.host.dispose() });
  window.openAccountModal = openAccountMode;

  const net = game.online;
  const box = document.createElement('div');
  if (net?.account) {
    const email = (await user())?.email; // auth-js is already loaded by now (we connected as this account)
    const info = document.createElement('div');
    info.style.cssText = 'margin:2px 0 4px; text-align:left;';
    const name = document.createElement('div');
    name.style.cssText = 'font-size:13px; color:#cfd8dc;';
    name.textContent = `Účet: ${net.nick}`;
    info.appendChild(name);
    if (email) {
      const emailEl = document.createElement('div');
      emailEl.style.cssText = 'font-size:11px; color:#78909c; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      emailEl.textContent = email;
      info.appendChild(emailEl);
    }
    box.appendChild(info);
    const signOutBtn = document.createElement('button');
    signOutBtn.textContent = 'Odhlásiť sa';
    signOutBtn.onclick = async () => {
      signOutBtn.disabled = true;
      await signOut();
      location.href = location.pathname + location.search; // drop #online: land on the plain menu
    };
    box.appendChild(signOutBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Zmazať účet';
    deleteBtn.onclick = () => openDeleteConfirm(game);
    box.appendChild(deleteBtn);
  } else {
    const hint = document.createElement('p');
    hint.className = 'hint small';
    hint.textContent = 'Vytvor si účet: postup na všetkých zariadeniach a hlasový chat.';
    box.appendChild(hint);
    const btn = document.createElement('button');
    btn.textContent = 'Vytvoriť účet / Prihlásiť sa';
    btn.onclick = openAccountMode;
    box.appendChild(btn);
  }
  addPauseControl(box, { onlineOnly: true });
}
