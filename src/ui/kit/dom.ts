// DOM helpers for the social features, in the same visual language as the existing #nick modal and
// #pause menu (see index.html and style.css): a modal builder, a labelled form field, a toast, a
// clipboard helper and a share-link helper, plus the pause menu's extension point.
// Plan: docs/plans/social-events.md
import './kit.css';

// ------------------------------------------------------------------------------------------- modal
let openModals = 0;

/** True while a kit modal is open. `openModal` already stops its own keydown from reaching
 *  Input.ts's window-level listener (see below), so most callers never need this; it's here for a
 *  feature that wants to skip its own hotkey handling too (e.g. not opening a second modal on top). */
export function isModalOpen() {
  return openModals > 0;
}

export interface ModalButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  /** returning `false` (including from a resolved promise) keeps the modal open; anything else closes it */
  onClick: () => void | boolean | Promise<void | boolean>;
}

export interface ModalOpts {
  title: string;
  body: string | HTMLElement;
  buttons: ModalButton[];
  onClose?: () => void;
}

/** Builds and shows a modal styled like the game's own (`.screen` + `.menu-card`, see style.css).
 *  Escape closes it; the first input (or else the primary button) gets focus. While it's open, its
 *  keydown/keyup never reach `window`, so Input.ts never sees them (see the KEYS.talk / party / …
 *  hotkeys and axis() in src/game/Input.ts) — typing in a field can't drive the car or fire a gun. */
export function openModal(opts: ModalOpts): { close(): void; el: HTMLElement } {
  const overlay = document.createElement('div');
  overlay.className = 'screen kit-modal';
  const card = document.createElement('div');
  card.className = 'menu-card small';
  const h2 = document.createElement('h2');
  h2.textContent = opts.title;
  card.appendChild(h2);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'kit-modal-body';
  if (typeof opts.body === 'string') {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = opts.body;
    bodyEl.appendChild(p);
  } else bodyEl.appendChild(opts.body);
  card.appendChild(bodyEl);

  const btnRow = document.createElement('div');
  btnRow.className = 'buttons';
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openModals--;
    overlay.remove();
    opts.onClose?.();
  };
  for (const b of opts.buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label;
    if (b.primary) btn.classList.add('primary');
    if (b.danger) btn.classList.add('danger');
    btn.onclick = async () => {
      const r = b.onClick();
      const v = r instanceof Promise ? await r : r;
      if (v !== false) close();
    };
    btnRow.appendChild(btn);
  }
  card.appendChild(btnRow);
  overlay.appendChild(card);

  // stop propagation on the way up, after the focused field/button has fully handled the key (so
  // typing, backspace, arrow-key cursor movement and Tab between fields all still work normally) —
  // see the module doc above.
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });

  document.body.appendChild(overlay);
  openModals++;
  setTimeout(() => {
    const first = bodyEl.querySelector<HTMLElement>('input, textarea, select');
    (first ?? btnRow.querySelector<HTMLElement>('button.primary'))?.focus();
  }, 0);
  return { close, el: overlay };
}

// ------------------------------------------------------------------------------------------- field
export interface FieldAttrs {
  type?: string;
  placeholder?: string;
  value?: string;
  maxLength?: number;
  minLength?: number;
  autocomplete?: string;
  required?: boolean;
  pattern?: string;
}

/** A labelled input for a modal's form (email/password/nickname…), styled like the game's own inputs. */
export function field(label: string, attrs: FieldAttrs = {}): { el: HTMLElement; input: HTMLInputElement } {
  const wrap = document.createElement('label');
  wrap.className = 'kit-field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = attrs.type ?? 'text';
  if (attrs.placeholder !== undefined) input.placeholder = attrs.placeholder;
  if (attrs.value !== undefined) input.value = attrs.value;
  if (attrs.maxLength !== undefined) input.maxLength = attrs.maxLength;
  if (attrs.minLength !== undefined) input.minLength = attrs.minLength;
  // setAttribute, not the .autocomplete property: its DOM type is a closed AutoFill union that
  // rejects some legitimate values (e.g. browser-specific hints), while the attribute takes any string
  if (attrs.autocomplete !== undefined) input.setAttribute('autocomplete', attrs.autocomplete);
  if (attrs.required !== undefined) input.required = attrs.required;
  if (attrs.pattern !== undefined) input.pattern = attrs.pattern;
  wrap.append(span, input);
  return { el: wrap, input };
}

// ------------------------------------------------------------------------------------------- toast
let toastEl: HTMLDivElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** A small DOM toast for things outside the canvas HUD (a copy-to-clipboard confirmation…). */
export function toast(text: string, color = '#69f0ae', ms = 2200) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'kit-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.borderLeftColor = color;
  // reflow so re-triggering the class while already shown still restarts the transition
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl?.classList.remove('show'), ms);
}

// ------------------------------------------------------------------------------------- clipboard
/** Clipboard write with an execCommand fallback (non-HTTPS, an older WebView, a denied permission). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** `navigator.share` when available (mostly mobile); otherwise copies the link and toasts it. */
export async function shareLink(url: string, title: string) {
  const nav = navigator as Navigator & { share?: (data: { title?: string; url?: string }) => Promise<void> };
  if (nav.share) {
    try {
      await nav.share({ title, url });
      return;
    } catch {
      /* cancelled, or unsupported despite existing: fall through to copy */
    }
  }
  const ok = await copyText(url);
  toast(ok ? 'Odkaz skopírovaný' : 'Odkaz sa nepodarilo skopírovať', ok ? '#69f0ae' : '#ff5252');
}

// -------------------------------------------------------------------------------- pause-menu extras
let pauseOnline = false;
const onlineOnlyEls: HTMLElement[] = [];

/** Reveals every control added with `{ onlineOnly: true }`. Call this once play goes online, right
 *  where main.ts already reveals `#btn-nick` (inside `startOnline`, after `game.setHost(session)`). */
export function setPauseOnline(on: boolean) {
  pauseOnline = on;
  for (const el of onlineOnlyEls) el.classList.toggle('hidden', !on);
}

/** Appends a control to the pause menu's extension point (`#pause-extra` in index.html), so features
 *  can add their own buttons/toggles without editing index.html. `onlineOnly` hides it until
 *  `setPauseOnline(true)` — for a control that makes sense only in the shared online world. */
export function addPauseControl(el: HTMLElement, opts: { onlineOnly?: boolean } = {}) {
  const host = document.getElementById('pause-extra');
  if (!host) return; // defensive: index.html always has it, but never throw over a missing host
  if (opts.onlineOnly) {
    el.classList.toggle('hidden', !pauseOnline);
    onlineOnlyEls.push(el);
  }
  host.appendChild(el);
}
