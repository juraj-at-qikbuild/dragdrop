// The main menu's "Napísať nám": a feedback / contact form in a kit modal. It posts to the Supabase
// Edge Function `contact` (src/net/contact.ts), which stores the message and e-mails it to us.
import { field, openModal, toast } from './kit/dom';
import { contactAvailable, MESSAGE_MAX, MESSAGE_MIN, sendContact } from '../net/contact';
import { hasStoredSession, user } from '../net/auth';
import { loadIdentity } from '../net/identity';

/** shows the menu's button when the form can actually send (the Supabase env vars are set) */
export function wireContactButton(btn: HTMLElement) {
  if (!contactAvailable()) return;
  btn.classList.remove('hidden');
  btn.onclick = () => openContact();
}

export function openContact() {
  const account = hasStoredSession();
  const nick = loadIdentity()?.nick ?? '';

  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = 'Našiel si chybu, máš nápad, alebo nám chceš len niečo povedať? Napíš.';

  const msgWrap = document.createElement('label');
  msgWrap.className = 'kit-field';
  const msgLabel = document.createElement('span');
  msgLabel.textContent = 'Správa';
  const message = document.createElement('textarea');
  message.rows = 6;
  message.maxLength = MESSAGE_MAX;
  message.required = true;
  message.placeholder = 'Čo sa stalo, kde v meste, čo by si zmenil…';
  msgWrap.append(msgLabel, message);

  const email = field('E-mail (nepovinný, ak chceš odpoveď)', { type: 'email', autocomplete: 'email', maxLength: 200 });
  // a signed-in account knows its own e-mail: filled in, still editable
  if (account)
    void user().then((u) => {
      if (u?.email && !email.input.value) email.input.value = u.email;
    });

  // the honeypot: off screen and out of the tab order, so only a bot fills it in
  const trap = document.createElement('input');
  trap.name = 'website';
  trap.tabIndex = -1;
  trap.autocomplete = 'off';
  trap.setAttribute('aria-hidden', 'true');
  trap.className = 'kit-trap';

  const err = document.createElement('p');
  err.className = 'error hidden';
  const setError = (msg: string | null) => {
    err.textContent = msg ?? '';
    err.classList.toggle('hidden', !msg);
  };

  const body = document.createElement('div');
  body.append(intro, msgWrap, email.el, trap, err);

  const handle = openModal({
    title: 'Napísať nám',
    body,
    buttons: [
      {
        label: 'Odoslať',
        primary: true,
        onClick: async () => {
          const text = message.value.trim();
          const mail = email.input.value.trim();
          if (text.length < MESSAGE_MIN) {
            setError('Napíš aspoň pár slov.');
            message.focus();
            return false;
          }
          if (mail && !email.input.checkValidity()) {
            setError('Zadaj platný e-mail, alebo ho nechaj prázdny.');
            email.input.focus();
            return false;
          }
          setError(null);
          const buttons = handle.el.querySelectorAll('button');
          buttons.forEach((b) => (b.disabled = true));
          const r = await sendContact({
            message: text,
            email: mail,
            nick,
            website: trap.value,
            context: { playedOnline: !!nick, account, page: location.host + location.pathname },
          });
          buttons.forEach((b) => (b.disabled = false));
          if (!r.ok) {
            setError(r.error);
            return false;
          }
          toast('Ďakujeme! Správa odoslaná.', '#69f0ae', 3000);
        },
      },
      { label: 'Zrušiť', onClick: () => {} },
    ],
  });
}
