// The nickname prompt, shared by the menu (src/main.ts) and the account chooser (src/ui/AccountUi.ts).
import { randomNick } from '../net/nicknames';
import { cleanNick } from '../shared/net/protocol';

const $ = (id: string) => document.getElementById(id)!;

/** Nickname prompt (the #nick dialog in index.html). Resolves with a valid nickname, or null when
 *  cancelled. Used by the menu (src/main.ts) and the account chooser's guest path (src/ui/AccountUi.ts). */
export function askNick(initial: string, okLabel: string): Promise<string | null> {
  const box = $('nick'), input = $('nick-input') as HTMLInputElement, err = $('nick-error');
  ($('nick-ok') as HTMLButtonElement).textContent = okLabel;
  input.value = initial;
  err.classList.add('hidden');
  box.classList.remove('hidden');
  setTimeout(() => input.select(), 0);
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      box.classList.add('hidden');
      ($('nick-form') as HTMLFormElement).onsubmit = null;
      $('nick-cancel').onclick = null;
      resolve(v);
    };
    $('nick-roll').onclick = () => {
      input.value = randomNick();
      input.focus();
    };
    ($('nick-form') as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      const n = cleanNick(input.value);
      if (!n) return err.classList.remove('hidden');
      done(n);
    };
    $('nick-cancel').onclick = () => done(null);
  });
}
