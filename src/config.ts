import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { parse } from 'yaml';
import { SEVERITIES, type Message, type Severity } from './message.ts';
import type { Delivery, Target } from './targets/shared.ts';
import { slack } from './targets/slack.ts';
import { discord } from './targets/discord.ts';
import { teams } from './targets/teams.ts';

const TARGET_TYPES: Record<string, Target<any>> = { slack, discord, teams };

export interface AppConfig {
  id: string; // used in URL paths (/eas/<id>, /asc/<id>) and as labels.app
  name: string; // display name in messages
  eas?: { secret: string };
  asc?: { secret: string };
  play?: { packageName: string; tracks: string[] };
}
export interface Route {
  types: string[]; // 'build.failed', 'appreview.*', '*'
  labels: Record<string, string>; // exact match, e.g. { platform: ios, profile: production }
  minSeverity: Severity;
  targets: string[];
  mention: boolean;
  silent: boolean;
}
/** A target bound to its parsed config. */
export interface TargetInstance {
  render(msg: Message, d: Delivery): unknown;
  send(payload: unknown): Promise<void>;
}
export interface AscApi {
  issuerId: string;
  keyId: string;
  privateKey: KeyObject;
}
export interface PlayApi {
  serviceAccount: { client_email: string; private_key: string };
  intervalMinutes: number;
}
export interface Config {
  port: number;
  stateStore?: string; // path to a module exporting get/set; in memory when unset
  apps: Map<string, AppConfig>;
  ascApi?: AscApi;
  playApi?: PlayApi;
  ingest?: { secret: string };
  targets: Map<string, TargetInstance>;
  routes: Route[];
}

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string, allowed?: string[]): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`config: ${where} must be a mapping`);
  // A typo like `minseverity` would otherwise silently disable a filter.
  const unknown = allowed && Object.keys(v).filter((k) => !allowed.includes(k));
  if (unknown?.length) throw new Error(`config: unknown key(s) in ${where}: ${unknown.join(', ')}`);
  return v as Obj;
}
function str(o: Obj, k: string, where: string): string {
  if (typeof o[k] !== 'string' || !o[k]) throw new Error(`config: ${where}.${k} must be a non-empty string`);
  return o[k] as string;
}
function strList(o: Obj, k: string, where: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && x)) throw new Error(`config: ${where}.${k} must be a non-empty list of strings`);
  return v;
}
// Errors never echo the value: a mistyped inline secret would be printed as a "path".
function inlineOrFile(v: string, inlineStart: string, baseDir: string, where: string): string {
  if (v.trimStart().startsWith(inlineStart)) return v;
  try {
    return readFileSync(resolve(baseDir, v), 'utf8');
  } catch (err) {
    throw new Error(`config: ${where} is neither inline (starting with ${inlineStart}) nor a readable file path (${(err as { code?: string }).code ?? 'unreadable'})`);
  }
}
function bool(o: Obj, k: string, where: string, fallback: boolean): boolean {
  const v = o[k] ?? fallback;
  if (v === false || v === 'false') return false;
  if (v === true || v === 'true') return true; // "true" too: ${VAR} interpolation always yields strings
  throw new Error(`config: ${where}.${k} must be true or false`);
}
function int(o: Obj, k: string, where: string, fallback: number, min: number, max: number): number {
  const v = Number(o[k] ?? fallback); // a string from "${VAR}" too
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`config: ${where}${k} must be a number from ${min} to ${max}`);
  return v;
}

/** Replace ${VAR} in string values only, after YAML parsing, so secrets containing : # or quotes can't break the YAML. */
export function interpolate(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === 'string')
    return v.replace(/\$\{(\w+)\}/g, (_, name: string) => {
      const value = env[name];
      if (value === undefined) throw new Error(`config: environment variable ${name} is not set`);
      return value;
    });
  if (Array.isArray(v)) return v.map((x) => interpolate(x, env));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, env)]));
  return v;
}

function parseApps(v: unknown): Map<string, AppConfig> {
  const apps = new Map<string, AppConfig>();
  for (const [id, raw] of Object.entries(obj(v, 'apps'))) {
    const w = `apps.${id}`;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`config: app id "${id}" may only contain a-z, 0-9 and -`);
    const a = obj(raw, w, ['name', 'eas', 'asc', 'play']);
    const eas = a.eas == null ? undefined : obj(a.eas, `${w}.eas`, ['secret']);
    const asc = a.asc == null ? undefined : obj(a.asc, `${w}.asc`, ['secret']);
    const play = a.play == null ? undefined : obj(a.play, `${w}.play`, ['packageName', 'tracks']);
    apps.set(id, {
      id,
      name: str(a, 'name', w),
      eas: eas && { secret: str(eas, 'secret', `${w}.eas`) },
      asc: asc && { secret: str(asc, 'secret', `${w}.asc`) },
      play: play && { packageName: str(play, 'packageName', `${w}.play`), tracks: strList(play, 'tracks', `${w}.play`) },
    });
  }
  return apps;
}

function parseAscApi(v: unknown, baseDir: string): AscApi {
  const a = obj(v, 'ascApi', ['issuerId', 'keyId', 'privateKey']);
  const pem = inlineOrFile(str(a, 'privateKey', 'ascApi'), '-----BEGIN', baseDir, 'ascApi.privateKey');
  return { issuerId: str(a, 'issuerId', 'ascApi'), keyId: str(a, 'keyId', 'ascApi'), privateKey: createPrivateKey(pem) };
}

function parsePlayApi(v: unknown, baseDir: string): PlayApi {
  const p = obj(v, 'playApi', ['serviceAccount', 'intervalMinutes']);
  const text = inlineOrFile(str(p, 'serviceAccount', 'playApi'), '{', baseDir, 'playApi.serviceAccount');
  let sa: { client_email?: unknown; private_key?: unknown } | null;
  try {
    sa = JSON.parse(text);
  } catch {
    throw new Error('config: playApi.serviceAccount is not valid JSON'); // not err.message: it quotes the private key
  }
  if (typeof sa?.client_email !== 'string' || typeof sa.private_key !== 'string') throw new Error('config: playApi.serviceAccount is not a service-account key JSON');
  return {
    serviceAccount: { client_email: sa.client_email, private_key: sa.private_key },
    intervalMinutes: int(p, 'intervalMinutes', 'playApi.', 15, 1, 24 * 60),
  };
}

function parseIngest(v: unknown): { secret: string } {
  const secret = str(obj(v, 'ingest', ['secret']), 'secret', 'ingest');
  // An empty or non-base64 key would make every signature forgeable.
  const b64 = secret.replace(/^whsec_/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || Buffer.from(b64, 'base64').length < 24)
    throw new Error('config: ingest.secret must be whsec_ followed by at least 24 base64-encoded random bytes (see README)');
  return { secret };
}

function parseTargets(v: unknown): Map<string, TargetInstance> {
  const targets = new Map<string, TargetInstance>();
  if (!Array.isArray(v) || !v.length) throw new Error('config: targets must be a non-empty list');
  for (const [i, raw] of v.entries()) {
    const t = obj(raw, `targets[${i}]`);
    const id = str(t, 'id', `targets[${i}]`);
    const type = str(t, 'type', `targets.${id}`);
    const target = Object.hasOwn(TARGET_TYPES, type) ? TARGET_TYPES[type] : undefined;
    if (!target) throw new Error(`config: targets.${id}.type must be one of ${Object.keys(TARGET_TYPES).join(', ')}`);
    obj(raw, `targets.${id}`, ['id', 'type', ...target.keys]);
    if (targets.has(id)) throw new Error(`config: duplicate target id ${id}`);
    let c: unknown;
    try {
      c = target.parseConfig(t);
    } catch (err) {
      throw new Error(`config: targets.${id}: ${(err as Error).message}`);
    }
    targets.set(id, { render: (m, d) => target.render(m, c, d), send: (payload) => target.send(payload, c) });
  }
  return targets;
}

function parseRoutes(v: unknown, targets: Map<string, TargetInstance>): Route[] {
  if (!Array.isArray(v) || !v.length) throw new Error('config: routes must be a non-empty list');
  return v.map((raw, i): Route => {
    const w = `routes[${i}]`;
    const r = obj(raw, w, ['types', 'labels', 'minSeverity', 'targets', 'mention', 'silent']);
    const types = strList(r, 'types', w);
    for (const t of types) if (t.indexOf('*') !== -1 && t.indexOf('*') !== t.length - 1) throw new Error(`config: ${w}.types: "*" is only allowed at the end ("${t}")`);
    const ids = strList(r, 'targets', w);
    for (const id of ids) if (!targets.has(id)) throw new Error(`config: ${w}.targets: unknown target "${id}"`);
    const minSeverity = (r.minSeverity ?? 'info') as Severity;
    if (!(SEVERITIES as readonly string[]).includes(minSeverity)) throw new Error(`config: ${w}.minSeverity must be one of ${SEVERITIES.join(', ')}`);
    const labels = r.labels == null ? {} : obj(r.labels, `${w}.labels`);
    for (const k of Object.keys(labels)) str(labels, k, `${w}.labels`);
    return { types, labels: labels as Record<string, string>, minSeverity, targets: ids, mention: bool(r, 'mention', w, false), silent: bool(r, 'silent', w, false) };
  });
}

export function parseConfig(raw: unknown, baseDir = '.'): Config {
  const root = obj(raw, 'root', ['port', 'stateStore', 'apps', 'ascApi', 'playApi', 'ingest', 'targets', 'routes']);
  const targets = parseTargets(root.targets);
  return {
    port: int(root, 'port', '', 8080, 1, 65535),
    stateStore: root.stateStore == null ? undefined : resolve(baseDir, str(root, 'stateStore', 'root')),
    apps: parseApps(root.apps),
    ascApi: root.ascApi == null ? undefined : parseAscApi(root.ascApi, baseDir),
    playApi: root.playApi == null ? undefined : parsePlayApi(root.playApi, baseDir),
    ingest: root.ingest == null ? undefined : parseIngest(root.ingest),
    targets,
    routes: parseRoutes(root.routes, targets),
  };
}

export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Config {
  const inline = env.STOREHERALD_CONFIG;
  return parseConfig(interpolate(parse(inline || readFileSync(path, 'utf8')), env), inline ? '.' : dirname(path));
}
