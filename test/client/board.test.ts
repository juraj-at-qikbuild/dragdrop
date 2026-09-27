// What the leaderboard panel says (src/game/features/leaderboard/text.ts): every board named and
// explained, the points list built from the points table itself, and the reset countdown.
import { describe, expect, it } from 'vitest';
import { BOARD_INFO, pointsHelp, until } from '../../src/game/features/leaderboard/text';
import { BOARDS, POINTS } from '../../src/shared/sim/rules/points';

describe('leaderboard text', () => {
  it('names and explains every board', () => {
    for (const b of BOARDS) {
      expect(BOARD_INFO[b].label.length, b).toBeGreaterThan(0);
      expect(BOARD_INFO[b].icon.length, b).toBeGreaterThan(0);
      expect(BOARD_INFO[b].about.length, b).toBeGreaterThan(10);
    }
  });

  it('lists what everything is worth, from the table itself', () => {
    const lines = pointsHelp();
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const l of lines) {
      expect(l).not.toMatch(/undefined|NaN|\$\{/);
    }
    const all = lines.join('\n');
    expect(all).toContain(`+${POINTS.race} b`);
    expect(all).toContain(`+${POINTS.daily} b`);
    expect(all).toContain(POINTS.getaway.slice(1).join(' / '));
    expect(all).toContain(POINTS.derby.join(' / '));
  });

  it('counts down to a new day or week in minutes, hours and days', () => {
    expect(until(10)).toBe('1 min');
    expect(until(90)).toBe('2 min');
    expect(until(3700)).toBe('1 h 2 min');
    expect(until(2 * 86400 + 5 * 3600)).toBe('2 d 5 h');
  });
});
