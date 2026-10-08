import { sign, timingSafeEqual, type KeyLike, type SignKeyObjectInput } from 'node:crypto';
import type { Severity } from '../message.ts';

/** Constant-time string compare. timingSafeEqual throws on a byte-length mismatch (non-ASCII headers), so compare buffers. */
export function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What a source's state change means: the message type, its severity and the title's verb phrase. */
export interface StateEvent {
  type: string;
  severity: Severity;
  what: string;
}

const PLATFORM: Record<string, string> = { ios: 'iOS', android: 'Android' };
export const platformName = (p: string | undefined) => (p ? PLATFORM[p.toLowerCase()] ?? p : 'iOS');

/** GET/POST returning parsed JSON; throws with the status and the start of the body on non-2xx. */
export async function fetchJson(what: string, url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? undefined : res.json();
}

const b64u = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
/** Compact JWS signed with SHA-256. */
export function signJwt(header: object, claims: object, key: KeyLike | SignKeyObjectInput): string {
  const input = `${b64u(header)}.${b64u(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}
