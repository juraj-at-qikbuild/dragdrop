// SDP munging for the Opus codec (MDN "munging SDP"; parameters per RFC 7587): enable discontinuous
// transmission (silence costs ~0 bandwidth while push-to-talk is up but not held, or between words)
// and in-band forward error correction (recovers a lost packet from redundant data in the next one,
// which matters a lot on the mobile networks players are on). Pure string surgery on the local
// description before it's set; the bitrate cap itself is a separate RTCRtpSender.setParameters() call
// (VoiceClient.ts), not an SDP attribute. docs/plans/social-events.md ("Proximity voice").

/**
 * Adds `usedtx=1;useinbandfec=1` to the Opus payload's `a=fmtp` line, creating one right after its
 * `a=rtpmap` line if the description has none. Leaves every other line — video, other audio codecs,
 * ICE/DTLS/candidate attributes — untouched. A no-op if the description has no Opus media at all.
 */
export function mungeOpusFec(sdp: string): string {
  const nl = sdp.includes('\r\n') ? '\r\n' : '\n'; // real SDP is \r\n; tolerate bare \n in test fixtures
  const lines = sdp.split(nl);
  const rtpmapIdx = lines.findIndex((l) => /^a=rtpmap:\d+ opus\/\d+/i.test(l));
  if (rtpmapIdx < 0) return sdp; // no Opus media section: nothing to munge
  const pt = lines[rtpmapIdx].match(/^a=rtpmap:(\d+)/)![1];
  const fmtpIdx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  if (fmtpIdx < 0) {
    lines.splice(rtpmapIdx + 1, 0, `a=fmtp:${pt} usedtx=1;useinbandfec=1`);
  } else {
    if (!/\busedtx=/.test(lines[fmtpIdx])) lines[fmtpIdx] += ';usedtx=1';
    if (!/\buseinbandfec=/.test(lines[fmtpIdx])) lines[fmtpIdx] += ';useinbandfec=1';
  }
  return lines.join(nl);
}
