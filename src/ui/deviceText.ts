// Key names in texts that come from the shared rules (mini-game goals and messages, the tram's hints),
// which don't know how the player plays: "zaplať (B)", "vystúp (F)", "bež (Shift)". The client says
// them the way the player plays: the key on a keyboard, the pad's button, the on-screen button on a
// touch screen. Pure, so test/client/deviceText.test.ts can check it.

export type Device = 'keys' | 'pad' | 'touch';

/** what each key is called per device; '' drops the "(X)" altogether */
const NAMES: Record<string, Record<Exclude<Device, 'keys'>, string>> = {
  B: { pad: 'R3', touch: 'fialové tlačidlo' },
  F: { pad: 'Y', touch: 'žlté tlačidlo' },
  H: { pad: 'X', touch: '📣' },
  J: { pad: 'krížik vľavo', touch: 'Aktivity' },
  U: { pad: 'krížik dole', touch: 'Aktivity' },
  Shift: { pad: 'A', touch: 'páčka naplno' },
};

const PAREN = /\((B|F|H|J|U|Shift)(\s[^)]*)?\)/g;
const PRESS = /stlač (B|F|H)\b/g;
const BARE = /\b(F) pri /g;

/** `text` with its key names said for `device` (unchanged on a keyboard) */
export function forDevice(text: string, device: Device): string {
  if (device === 'keys' || !text) return text;
  return text
    .replace(PAREN, (_, k: string, rest = '') => {
      const n = NAMES[k][device];
      return n ? `(${n}${rest})` : '';
    })
    .replace(PRESS, (_, k: string) => (device === 'touch' ? `ťukni na ${NAMES[k].touch}` : `stlač ${NAMES[k].pad}`))
    .replace(BARE, (_, k: string) => `${NAMES[k][device]} pri `)
    .replace(/W plyn · S brzda · A\/D výhybka · H zvonček/, device === 'touch' ? 'páčkou dopredu plyn, dozadu brzda, do strán výhybka · 📣 zvonček' : 'RT plyn · LT brzda · páčka výhybka · X zvonček');
}
