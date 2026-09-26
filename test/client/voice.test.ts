// Pure-logic tests for the proximity voice client helpers (src/game/features/voice/): the distance/pan
// gain curve, and the Opus SDP munge. Node environment (vitest.config.ts) — no DOM or WebRTC involved.
import { describe, expect, it } from 'vitest';
import { voiceGain, voicePan } from '../../src/game/features/voice/voiceMath';
import { mungeOpusFec } from '../../src/game/features/voice/sdp';

describe('voiceGain', () => {
  it('is full volume right next to the listener', () => {
    expect(voiceGain(0, false, false, 1)).toBeCloseTo(1, 5);
  });

  it('fades out with distance and hits 0 at/after 45 m', () => {
    const near = voiceGain(5, false, false, 1);
    const mid = voiceGain(30, false, false, 1);
    const far = voiceGain(44, false, false, 1);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(voiceGain(45, false, false, 1)).toBe(0);
    expect(voiceGain(100, false, false, 1)).toBe(0);
  });

  it('follows the (45−d)/40 ^ 1.5 curve exactly', () => {
    const d = 20;
    const expected = ((45 - d) / 40) ** 1.5;
    expect(voiceGain(d, false, false, 1)).toBeCloseTo(expected, 10);
  });

  it('multiplies by 0.15 on a level mismatch (e.g. one player in a tunnel)', () => {
    const normal = voiceGain(10, false, false, 1);
    const mismatched = voiceGain(10, true, false, 1);
    expect(mismatched).toBeCloseTo(normal * 0.15, 10);
  });

  it('is 0 while muted, regardless of distance or volume', () => {
    expect(voiceGain(0, false, true, 1)).toBe(0);
    expect(voiceGain(0, true, true, 1)).toBe(0);
  });

  it('scales with the voice-volume setting, and is 0 at volume 0', () => {
    expect(voiceGain(10, false, false, 0.5)).toBeCloseTo(voiceGain(10, false, false, 1) * 0.5, 10);
    expect(voiceGain(10, false, false, 0)).toBe(0);
  });

  it('clamps a negative distance (coincident positions) to full gain, never above 1', () => {
    expect(voiceGain(-5, false, false, 1)).toBeCloseTo(1, 5);
  });
});

describe('voicePan', () => {
  it('is centred (0) for a peer directly ahead/behind (dx=0)', () => {
    expect(voicePan(0)).toBe(0);
  });

  it('pans right for a positive dx and left for a negative one, symmetrically', () => {
    expect(voicePan(10)).toBeGreaterThan(0);
    expect(voicePan(-10)).toBeLessThan(0);
    expect(voicePan(10)).toBeCloseTo(-voicePan(-10), 10);
  });

  it('follows dx/25 up to the 0.8 cap, and saturates beyond it', () => {
    expect(voicePan(12.5)).toBeCloseTo(0.4, 10); // 12.5/25 * 0.8
    expect(voicePan(25)).toBeCloseTo(0.8, 10);
    expect(voicePan(1000)).toBeCloseTo(0.8, 10); // clamped, never exceeds the cap
    expect(voicePan(-1000)).toBeCloseTo(-0.8, 10);
  });
});

describe('mungeOpusFec', () => {
  it('appends usedtx and useinbandfec to an existing Opus fmtp line', () => {
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;stereo=1', 'a=ptime:20'].join('\r\n');
    const out = mungeOpusFec(sdp);
    const fmtp = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
    expect(fmtp).toBe('a=fmtp:111 minptime=10;stereo=1;usedtx=1;useinbandfec=1');
    // every other line is untouched, in place
    expect(out.split('\r\n')).toEqual(['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', fmtp, 'a=ptime:20']);
  });

  it('creates an fmtp line when the Opus payload has none', () => {
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=ptime:20'].join('\r\n');
    const out = mungeOpusFec(sdp).split('\r\n');
    expect(out).toContain('a=fmtp:111 usedtx=1;useinbandfec=1');
    expect(out.indexOf('a=fmtp:111 usedtx=1;useinbandfec=1')).toBe(out.indexOf('a=rtpmap:111 opus/48000/2') + 1);
  });

  it('is idempotent: munging twice does not duplicate the parameters', () => {
    const sdp = ['v=0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10'].join('\r\n');
    const once = mungeOpusFec(sdp);
    const twice = mungeOpusFec(once);
    expect(twice).toBe(once);
  });

  it('leaves an SDP with no Opus media untouched', () => {
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 0', 'a=rtpmap:0 PCMU/8000'].join('\r\n');
    expect(mungeOpusFec(sdp)).toBe(sdp);
  });

  it('only touches the fmtp line belonging to the Opus payload type, not another codec sharing the section', () => {
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 0', 'a=rtpmap:111 opus/48000/2', 'a=rtpmap:0 PCMU/8000', 'a=fmtp:0 something=1'].join('\r\n');
    const out = mungeOpusFec(sdp).split('\r\n');
    expect(out).toContain('a=fmtp:0 something=1'); // PCMU's fmtp is untouched
    expect(out).toContain('a=fmtp:111 usedtx=1;useinbandfec=1');
  });

  it('tolerates bare \\n line endings (round-trips the same separator)', () => {
    const sdp = ['v=0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10'].join('\n');
    const out = mungeOpusFec(sdp);
    expect(out).toBe(['v=0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;usedtx=1;useinbandfec=1'].join('\n'));
  });
});
