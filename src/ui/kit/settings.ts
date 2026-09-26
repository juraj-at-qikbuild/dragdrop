// localStorage-backed settings for the social features' pause-menu controls (voice mode, mic choice,
// volume…), in the same try/catch-safe idiom as main.ts's QUALITY_KEY: storage can throw (private
// mode, quota, disabled), so a setting always falls back rather than breaking the caller.
// Plan: docs/plans/social-events.md

const PREFIX = 'blava-city-';

export interface Setting<T> {
  get(): T;
  set(v: T): void;
}

/** `key` is prefixed with `blava-city-`. `validate` (a type guard) rejects a stored value that no
 *  longer fits (an old enum member, a corrupt JSON blob): the fallback is returned instead. */
export function setting<T>(key: string, fallback: T, validate?: (v: unknown) => v is T): Setting<T> {
  const full = PREFIX + key;
  return {
    get(): T {
      try {
        const raw = localStorage.getItem(full);
        if (raw === null) return fallback;
        const v = JSON.parse(raw) as unknown;
        return !validate || validate(v) ? (v as T) : fallback;
      } catch {
        return fallback;
      }
    },
    set(v: T) {
      try {
        localStorage.setItem(full, JSON.stringify(v));
      } catch {
        /* storage unavailable: the setting just won't persist this session */
      }
    },
  };
}
