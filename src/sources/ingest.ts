// Custom events from CI, e.g. an EAS Workflow step reporting update.published. Signed with Standard Webhooks:
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
import { createHmac } from 'node:crypto';
import { SEVERITIES, type Message } from '../message.ts';
import { safeEq } from './shared.ts';

export interface StdHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/** Signature over `${id}.${timestamp}.${body}` with the base64 key after "whsec_"; rejects timestamps more than 5 min off. */
export function verifyIngest(raw: Buffer, h: StdHeaders, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${h.id}.${h.timestamp}.`).update(raw).digest('base64');
  return h.signature.split(' ').some((s) => s.startsWith('v1,') && safeEq(s.slice(3), expected));
}

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isPairs = <K extends string>(v: unknown, a: K, b: K, max: number, check: (x: string) => boolean = () => true) =>
  v === undefined ||
  (Array.isArray(v) && v.length <= max && v.every((x) => x && typeof x === 'object' && isStr(x[a], 200) && isStr(x[b], 3000) && check(x[b])));

/** Strict: this is a trust boundary. Returns an error string instead of a Message on bad input. */
export function ingestToMessage(id: string, p: any): Message | string {
  if (!p || typeof p !== 'object') return 'body must be a JSON object';
  if (!isStr(p.type, 100) || !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(p.type)) return 'type must look like "update.published"';
  if (!isStr(p.title, 500)) return 'title is required (max 500 chars)';
  if (p.severity !== undefined && !SEVERITIES.includes(p.severity)) return `severity must be one of ${SEVERITIES.join(', ')}`;
  if (p.time !== undefined && (typeof p.time !== 'string' || Number.isNaN(Date.parse(p.time)))) return 'time must be an ISO 8601 date';
  for (const k of ['body', 'actor', 'source']) if (p[k] !== undefined && !isStr(p[k], 4000)) return `${k} must be a non-empty string`;
  if (!isPairs(p.fields, 'label', 'value', 20)) return 'fields must be a list of {label, value}';
  if (!isPairs(p.links, 'label', 'url', 10, (u) => URL.canParse(u) && ['http:', 'https:'].includes(new URL(u).protocol))) return 'links must be a list of {label, url} with http(s) urls';
  const labels = p.labels ?? {};
  if (typeof labels !== 'object' || Array.isArray(labels) || !Object.values(labels).every((v) => isStr(v, 200))) return 'labels must map strings to strings';
  return {
    id: `ingest:${id}`,
    type: p.type,
    source: p.source ?? 'CI',
    severity: p.severity ?? 'info',
    time: p.time,
    title: p.title,
    body: p.body,
    actor: p.actor,
    fields: p.fields,
    links: p.links,
    labels,
  };
}
