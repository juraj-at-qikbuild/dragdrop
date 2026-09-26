// The shape of the account-token verifier a real auth feature plugs into Room (the eventual
// server/src/auth.ts, checking a Supabase access token against its JWKS with `jose`). Kept as its own
// tiny interface so Room — and its tests — never depend on `jose` or Supabase, only on this shape.
// Plan: docs/plans/social-events.md
export interface AuthVerifier {
  /** null: the token doesn't verify (expired, malformed, wrong issuer, revoked…) */
  verify(token: string): Promise<{ userId: string; email?: string } | null>;
}
