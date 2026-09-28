/** Input pulse throttle shared by keyboard, mouse, touch and gamepad. No durations leave the client. */
export class EngagementPulse {
  private sentAt = -Infinity;
  private seen = 0;
  poll(now: number, activity: number, enabled: boolean): boolean {
    if (!enabled) { this.seen = activity; return false; }
    if (activity === this.seen) return false;
    // Do not queue an old input and send it later while the player is idle.
    this.seen = activity;
    if (now - this.sentAt < 5000) return false;
    this.sentAt = now;
    return true;
  }
  reset() { this.sentAt = -Infinity; }
}
