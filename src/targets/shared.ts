import type { Message, Severity } from '../message.ts';

/** Per-delivery switches, set by the route that matched. */
export interface Delivery {
  mention: boolean; // ping the target's configured mention
  silent: boolean; // no push notification, where the platform supports it (Discord)
}

export interface Target<C> {
  /** Config keys besides id/type, so typos fail at startup instead of being ignored. */
  keys: string[];
  /** Validate and normalize raw config once at startup. Throws on bad config. */
  parseConfig(raw: Record<string, unknown>): C;
  /** Pure: Message -> platform JSON. No I/O, so it's testable on its own. */
  render(msg: Message, cfg: C, d: Delivery): unknown;
  send(payload: unknown, cfg: C): Promise<void>;
}

/** T's keys, from a literal that must name each of them once: a parser's key list can't drift from the documented type. */
export const keysOf = <T>(keys: Record<keyof T, true>) => Object.keys(keys);

export const SEVERITY: Record<Severity, { emoji: string; color: number }> = {
  info: { emoji: 'ℹ️', color: 0x3aa3e3 },
  success: { emoji: '✅', color: 0x3aa337 },
  warning: { emoji: '⚠️', color: 0xcacf29 },
  error: { emoji: '🔴', color: 0xa32037 },
};

/**
 * Cut to `max` UTF-16 units, which is >= code points, so it fits whichever way a platform counts.
 * Never splits a surrogate pair. Call it after escaping, so escapes can't push text over the limit.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out + '…';
}

/** Empty values dropped (Slack and Discord reject empty text), then capped. */
export const fieldsOf = (m: Message, max: number) => (m.fields ?? []).filter((f) => f.value.trim()).slice(0, max);
/** Links whose URL a platform would reject are dropped: one bad button fails the whole post. */
export const linksOf = (m: Message, max: number, maxUrl = Infinity) =>
  (m.links ?? []).filter((l) => l.url.length <= maxUrl).slice(0, max);
export const bodyOf = (m: Message) => m.body?.trim() || undefined;

// Short on purpose: the sender (Expo, Apple) waits for our reply, and its own retries cover longer outages.
const RETRIES = 1;
const MAX_WAIT_MS = 2_000;
const TIMEOUT_MS = 5_000;

/** Retry-After in seconds (1 s if missing or unparsable), capped so one bad header can't stall the reply. */
function retryDelayMs(res: Response | undefined): number {
  const secs = Number(res?.headers.get('retry-after') ?? NaN); // header missing -> NaN, not Number(null) = 0
  return Math.min((Number.isFinite(secs) && secs >= 0 ? secs : 1) * 1000, MAX_WAIT_MS);
}

/** HTTP status attached to errors thrown by postJson (undefined for network errors and timeouts). */
export const statusOf = (err: unknown) => (err as { status?: number }).status;

/** POST, retrying network errors, timeouts, 429 and 5xx. Throws an Error with `status` (none for network errors). */
export async function postJson(url: string, body: unknown): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'app-release-notifier/0.1' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // ponytail: retried even when the request may have landed (Discord webhooks have no idempotency key). A duplicate alert beats a lost one.
      if (attempt >= RETRIES) throw err;
    }
    if (res) {
      if (res.ok) return void (await res.body?.cancel()); // unread bodies can stall undici connections
      if (attempt >= RETRIES || !(res.status === 429 || res.status >= 500)) {
        // 404/410 mean the webhook is gone: the caller should stop using it.
        const text = await res.text().catch(() => ''); // a failed body read must not lose the status
        throw Object.assign(new Error(`POST failed: ${res.status} ${text.slice(0, 500)}`), { status: res.status });
      }
      await res.body?.cancel();
    }
    await new Promise((r) => setTimeout(r, retryDelayMs(res)));
  }
}

export function str(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v !== 'string' || !v) throw new Error(`"${key}" must be a non-empty string`);
  return v;
}
/** An http(s) URL, checked at startup. Errors never echo the value: webhook URLs are secrets. */
export function httpUrl(raw: Record<string, unknown>, key: string): URL {
  const v = str(raw, key);
  const url = URL.canParse(v) ? new URL(v) : undefined;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error(`"${key}" must be an http(s) URL`);
  return url;
}
export const optStr = (raw: Record<string, unknown>, key: string) => (raw[key] == null ? undefined : str(raw, key));
