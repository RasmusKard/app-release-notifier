import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { parse } from 'yaml';
import { SEVERITIES, type Severity } from './message.ts';
import type { Target } from './targets/shared.ts';
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
export interface TargetInstance {
  target: Target<any>;
  cfg: unknown;
}
export interface Config {
  port: number;
  stateStore?: string; // path to a module exporting get/set; in memory when unset
  apps: Map<string, AppConfig>;
  ascApi?: { issuerId: string; keyId: string; privateKey: KeyObject };
  playApi?: { serviceAccount: { client_email: string; private_key: string }; intervalMinutes: number };
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
/**
 * A PEM/JSON value inline, or a path (relative to the config file) to a file holding it. Multi-line secrets are awkward
 * in env vars. Errors never include the value: a mistyped inline secret would otherwise be printed as a "path".
 */
function inlineOrFile(v: string, inlineStart: string, baseDir: string, where: string): string {
  if (v.trimStart().startsWith(inlineStart)) return v;
  try {
    return readFileSync(resolve(baseDir, v), 'utf8');
  } catch (err) {
    throw new Error(`config: ${where} is neither inline (starting with ${inlineStart}) nor a readable file path (${(err as { code?: string }).code ?? 'unreadable'})`);
  }
}
function bool(o: Obj, k: string, where: string): boolean {
  const v = o[k];
  if (v == null || v === false || v === 'false') return false;
  if (v === true || v === 'true') return true; // "true" too: ${VAR} interpolation always yields strings
  throw new Error(`config: ${where}.${k} must be true or false`);
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

/** Relative paths (stateStore, key files) resolve against `baseDir`, the config file's folder. */
export function parseConfig(raw: unknown, baseDir = '.'): Config {
  const root = obj(raw, 'root', ['port', 'stateStore', 'apps', 'ascApi', 'playApi', 'ingest', 'targets', 'routes']);

  const apps = new Map<string, AppConfig>();
  for (const [id, v] of Object.entries(obj(root.apps, 'apps'))) {
    const w = `apps.${id}`;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`config: app id "${id}" may only contain a-z, 0-9 and -`);
    const a = obj(v, w, ['name', 'eas', 'asc', 'play']);
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

  let ascApi: Config['ascApi'];
  if (root.ascApi != null) {
    const a = obj(root.ascApi, 'ascApi', ['issuerId', 'keyId', 'privateKey']);
    const pem = inlineOrFile(str(a, 'privateKey', 'ascApi'), '-----BEGIN', baseDir, 'ascApi.privateKey');
    ascApi = { issuerId: str(a, 'issuerId', 'ascApi'), keyId: str(a, 'keyId', 'ascApi'), privateKey: createPrivateKey(pem) };
  }

  let playApi: Config['playApi'];
  if (root.playApi != null) {
    const p = obj(root.playApi, 'playApi', ['serviceAccount', 'intervalMinutes']);
    let sa;
    try {
      sa = JSON.parse(inlineOrFile(str(p, 'serviceAccount', 'playApi'), '{', baseDir, 'playApi.serviceAccount'));
    } catch (err) {
      // JSON.parse errors quote the start of the text, which here is a private key.
      throw (err as Error).message.startsWith('config:') ? err : new Error('config: playApi.serviceAccount is not valid JSON');
    }
    if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') throw new Error('config: playApi.serviceAccount is not a service-account key JSON');
    const interval = p.intervalMinutes ?? 15;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 1 || interval > 24 * 60) throw new Error('config: playApi.intervalMinutes must be a number from 1 to 1440');
    playApi = { serviceAccount: sa, intervalMinutes: interval };
  }

  let ingest: Config['ingest'];
  if (root.ingest != null) {
    const secret = str(obj(root.ingest, 'ingest', ['secret']), 'secret', 'ingest');
    // An empty or non-base64 key would make every signature forgeable. Standard Webhooks keys are 24-64 random bytes.
    const b64 = secret.replace(/^whsec_/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || Buffer.from(b64, 'base64').length < 24)
      throw new Error('config: ingest.secret must be whsec_ followed by at least 24 base64-encoded random bytes (see README)');
    ingest = { secret };
  }

  const targets = new Map<string, TargetInstance>();
  if (!Array.isArray(root.targets) || !root.targets.length) throw new Error('config: targets must be a non-empty list');
  for (const [i, v] of root.targets.entries()) {
    const t = obj(v, `targets[${i}]`);
    const id = str(t, 'id', `targets[${i}]`);
    const type = str(t, 'type', `targets.${id}`);
    const target = Object.hasOwn(TARGET_TYPES, type) ? TARGET_TYPES[type] : undefined;
    if (!target) throw new Error(`config: targets.${id}.type must be one of ${Object.keys(TARGET_TYPES).join(', ')}`);
    obj(v, `targets.${id}`, ['id', 'type', ...target.keys]);
    if (targets.has(id)) throw new Error(`config: duplicate target id ${id}`);
    try {
      targets.set(id, { target, cfg: target.parseConfig(t) });
    } catch (err) {
      throw new Error(`config: targets.${id}: ${(err as Error).message}`);
    }
  }

  if (!Array.isArray(root.routes) || !root.routes.length) throw new Error('config: routes must be a non-empty list');
  const routes = root.routes.map((v, i): Route => {
    const w = `routes[${i}]`;
    const r = obj(v, w, ['types', 'labels', 'minSeverity', 'targets', 'mention', 'silent']);
    const types = strList(r, 'types', w);
    for (const t of types) if (t.indexOf('*') !== -1 && t.indexOf('*') !== t.length - 1) throw new Error(`config: ${w}.types: "*" is only allowed at the end ("${t}")`);
    const ids = strList(r, 'targets', w);
    for (const id of ids) if (!targets.has(id)) throw new Error(`config: ${w}.targets: unknown target "${id}"`);
    const minSeverity = (r.minSeverity ?? 'info') as Severity;
    if (!(SEVERITIES as readonly string[]).includes(minSeverity)) throw new Error(`config: ${w}.minSeverity must be one of ${SEVERITIES.join(', ')}`);
    const labels = r.labels == null ? {} : obj(r.labels, `${w}.labels`);
    for (const k of Object.keys(labels)) str(labels, k, `${w}.labels`);
    return { types, labels: labels as Record<string, string>, minSeverity, targets: ids, mention: bool(r, 'mention', w), silent: bool(r, 'silent', w) };
  });

  const port = root.port == null ? 8080 : Number(root.port); // a string from "${PORT}" too
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('config: port must be a number from 1 to 65535');

  return {
    port,
    stateStore: root.stateStore == null ? undefined : resolve(baseDir, str(root, 'stateStore', 'root')),
    apps,
    ascApi,
    playApi,
    ingest,
    targets,
    routes,
  };
}

export const loadConfig = (path: string) => parseConfig(interpolate(parse(readFileSync(path, 'utf8')), process.env), dirname(path));
