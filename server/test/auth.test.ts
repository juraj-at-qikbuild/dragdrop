import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet, type JWK } from 'jose';
import { createSupabaseVerifier } from '../src/auth';
import { Store } from '../src/db';

const URL = 'https://proj.supabase.co';
const ISSUER = URL + '/auth/v1';

/** a fresh ES256 key pair, exported as a JWKS-ready public JWK with the given `kid` */
async function keyPair(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' } as JWK;
  return { privateKey, jwk };
}

const jwks = (...keys: JWK[]): JSONWebKeySet => ({ keys });

/** signs a Supabase-shaped access token; `exp` is unix seconds (default: one hour out) */
async function sign(privateKey: CryptoKey, kid: string, sub: string, extra: Record<string, unknown> = {}, over: { iss?: string; aud?: string; exp?: number } = {}) {
  return new SignJWT(extra)
    .setProtectedHeader({ alg: 'ES256', kid })
    .setSubject(sub)
    .setIssuedAt()
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? 'authenticated')
    .setExpirationTime(over.exp ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

async function withDb(fn: (file: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'blava-auth-'));
  try {
    await fn(path.join(dir, 'test.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('createSupabaseVerifier', () => {
  it('accepts a valid token and returns the user id and email', async () => {
    const { privateKey, jwk } = await keyPair('k1');
    const verifier = createSupabaseVerifier({ url: URL, fetchJwks: async () => jwks(jwk) });
    const token = await sign(privateKey, 'k1', 'u1', { email: 'fero@example.com' });
    await expect(verifier.verify(token)).resolves.toEqual({ userId: 'u1', email: 'fero@example.com' });
  });

  it('resolves null for an expired token', async () => {
    const { privateKey, jwk } = await keyPair('k1');
    const verifier = createSupabaseVerifier({ url: URL, fetchJwks: async () => jwks(jwk) });
    const token = await sign(privateKey, 'k1', 'u1', {}, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(verifier.verify(token)).resolves.toBeNull();
  });

  it('resolves null for the wrong audience', async () => {
    const { privateKey, jwk } = await keyPair('k1');
    const verifier = createSupabaseVerifier({ url: URL, fetchJwks: async () => jwks(jwk) });
    const token = await sign(privateKey, 'k1', 'u1', {}, { aud: 'not-authenticated' });
    await expect(verifier.verify(token)).resolves.toBeNull();
  });

  it('resolves null for the wrong issuer', async () => {
    const { privateKey, jwk } = await keyPair('k1');
    const verifier = createSupabaseVerifier({ url: URL, fetchJwks: async () => jwks(jwk) });
    const token = await sign(privateKey, 'k1', 'u1', {}, { iss: 'https://evil.example.com/auth/v1' });
    await expect(verifier.verify(token)).resolves.toBeNull();
  });

  it('resolves null for an anonymous user', async () => {
    const { privateKey, jwk } = await keyPair('k1');
    const verifier = createSupabaseVerifier({ url: URL, fetchJwks: async () => jwks(jwk) });
    const token = await sign(privateKey, 'k1', 'u1', { is_anonymous: true });
    await expect(verifier.verify(token)).resolves.toBeNull();
  });

  it('refetches once on an unknown kid (a key rotation) and then verifies', async () => {
    const a = await keyPair('k1');
    const b = await keyPair('k2'); // the "new" key, not yet in the first served JWKS
    const fetchJwks = vi.fn<() => Promise<JSONWebKeySet>>().mockResolvedValueOnce(jwks(a.jwk)).mockResolvedValue(jwks(a.jwk, b.jwk));
    const verifier = createSupabaseVerifier({ url: URL, fetchJwks });
    const token = await sign(b.privateKey, 'k2', 'u2');
    await expect(verifier.verify(token)).resolves.toEqual({ userId: 'u2' });
    expect(fetchJwks).toHaveBeenCalledTimes(2); // the boot fetch, then one refetch triggered by the unknown kid
  });

  it('does not refetch again for a second unknown kid within the 30s throttle window', async () => {
    const a = await keyPair('k1');
    const fetchJwks = vi.fn<() => Promise<JSONWebKeySet>>().mockResolvedValue(jwks(a.jwk));
    const verifier = createSupabaseVerifier({ url: URL, fetchJwks });
    const bogus = await keyPair('bogus');
    const token = await sign(bogus.privateKey, 'bogus', 'u3');
    await verifier.verify(token);
    const callsAfterFirst = fetchJwks.mock.calls.length;
    await verifier.verify(token);
    expect(fetchJwks.mock.calls.length).toBe(callsAfterFirst); // throttled: no extra fetch
  });

  it('verifies against the JWKS persisted in the store when the live fetch fails', async () => {
    await withDb(async (file) => {
      const store = new Store(file);
      const { privateKey, jwk } = await keyPair('k1');
      store.setWorld('jwks', JSON.stringify(jwks(jwk)));
      const verifier = createSupabaseVerifier({ url: URL, store, fetchJwks: async () => Promise.reject(new Error('network down')) });
      const token = await sign(privateKey, 'k1', 'u1');
      await expect(verifier.verify(token)).resolves.toEqual({ userId: 'u1' });
      store.close();
    });
  });

  it('rejects when no keys can be obtained at all (Room maps this to auth-unavailable)', async () => {
    const { privateKey } = await keyPair('k1');
    const verifier = createSupabaseVerifier({ url: URL, fetchJwks: async () => Promise.reject(new Error('network down')) });
    const token = await sign(privateKey, 'k1', 'u1');
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});
