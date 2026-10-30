// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
import { createHmac } from 'node:crypto';
import { SEVERITIES, type Message, type Severity } from '../message.ts';
import { DEFAULTS } from './ingest.defaults.ts';
import { safeEq } from './shared.ts';

/**
 * The JSON body of a `POST /ingest`, signed with Standard Webhooks. A missing or bad signature, or a timestamp more than
 * 5 minutes off, gets a 401. An invalid body gets a 400 with the reason. Unknown keys are ignored.
 */
export interface IngestEvent {
  /** The type routes match on: lowercase words joined by dots, such as `update.published`. Up to 100 characters. */
  type: string;
  /** Up to 500 characters. */
  title: string;
  /** @default `'info'` */
  severity?: Severity;
  /** When it happened, as an ISO 8601 date. When unset, the time it was received. */
  time?: string;
  /** Plain text, may be multi-line. Up to 4000 characters; Slack shows the first 3000, Discord 2000 and Teams 1000. */
  body?: string;
  /** Who triggered it. Up to 4000 characters. */
  actor?: string;
  /**
   * Where it came from, shown in the message. Up to 4000 characters.
   * @default `'CI'`
   */
  source?: string;
  /** Up to 20, with labels up to 200 and values up to 3000 characters. Slack and Discord show the first 10, Teams the first 6. */
  fields?: { label: string; value: string }[];
  /**
   * Up to 10 http(s) links, with labels up to 200 characters. The first one also makes the title a link. Slack and
   * Discord show the first 5, Teams the first 6. Discord drops URLs over 512 characters, Teams over 2048.
   */
  links?: { label: string; url: string }[];
  /** Labels routes match on, such as `{ "app": "myapp" }`. Never shown. Values up to 200 characters. */
  labels?: Record<string, string>;
}

export interface StdHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

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

type Obj = Record<string, unknown>;

function textError(p: Obj): string | undefined {
  if (!isStr(p.type, 100) || !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(p.type)) return 'type must look like "update.published"';
  if (!isStr(p.title, 500)) return 'title is required (max 500 chars)';
  if (p.severity !== undefined && !(SEVERITIES as readonly unknown[]).includes(p.severity)) return `severity must be one of ${SEVERITIES.join(', ')}`;
  if (p.time !== undefined && (typeof p.time !== 'string' || Number.isNaN(Date.parse(p.time)))) return 'time must be an ISO 8601 date';
  for (const k of ['body', 'actor', 'source'] satisfies (keyof IngestEvent)[]) if (p[k] !== undefined && !isStr(p[k], 4000)) return `${k} must be a non-empty string`;
}

function listError(p: Obj): string | undefined {
  if (!isPairs(p.fields, 'label', 'value', 20)) return 'fields must be a list of {label, value}';
  if (!isPairs(p.links, 'label', 'url', 10, (u) => URL.canParse(u) && ['http:', 'https:'].includes(new URL(u).protocol))) return 'links must be a list of {label, url} with http(s) urls';
  const labels: unknown = p.labels ?? {};
  if (!labels || typeof labels !== 'object' || Array.isArray(labels) || !Object.values(labels).every((v) => isStr(v, 200))) return 'labels must map strings to strings';
}

/** Strict: this is a trust boundary. Returns an error string instead of a Message on bad input. */
export function ingestToMessage(id: string, body: unknown): Message | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const err = textError(body as Obj) ?? listError(body as Obj);
  if (err) return err;
  const e = body as IngestEvent; // textError and listError checked every key
  return {
    id: `ingest:${id}`,
    type: e.type,
    source: e.source ?? DEFAULTS.IngestEvent.source,
    severity: e.severity ?? DEFAULTS.IngestEvent.severity,
    time: e.time,
    title: e.title,
    body: e.body,
    actor: e.actor,
    fields: e.fields,
    links: e.links,
    labels: e.labels ?? {},
  };
}
