import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { parse } from 'yaml';
import { SEVERITIES, type Message, type Severity } from './message.ts';
import type { IngestEvent } from './sources/ingest.ts';
import { keysOf, type Delivery, type Target } from './targets/shared.ts';
import { slack, type SlackTarget } from './targets/slack.ts';
import { discord, type DiscordTarget } from './targets/discord.ts';
import { teams, type TeamsTarget } from './targets/teams.ts';
import { DEFAULTS } from './config.defaults.ts';

const TARGET_TYPES: Record<string, Target<any>> = { slack, discord, teams };

/**
 * The config file: YAML, read at startup from the path given as the server's argument (`config.yaml` when none is),
 * or from the `STOREHERALD_CONFIG` environment variable when it's set, for hosts that can't mount a file. An unknown key
 * fails startup.
 *
 * `"${VAR}"` in a string value is replaced with the environment variable `VAR`, and startup fails when it's unset.
 * Quote it: inside `{ ... }` an unquoted `${VAR}` is a YAML syntax error. Numbers and booleans may be strings, so they
 * can come from `"${VAR}"` too. Relative paths resolve against the config file's folder, or
 * the working directory for `STOREHERALD_CONFIG`.
 */
export interface ConfigFile {
  /**
   * The port to listen on.
   * @default `8080`
   */
  port?: number;
  /**
   * A path to a module exporting `get(key)` and `set(key, value)`, named or on a default export, where the Google Play
   * poller keeps the release states it has seen. Values are strings. `get` returns `undefined` when nothing is stored
   * and throws on errors, which skips that poll. When unset, states are kept in memory and lost on restart.
   */
  stateStore?: string;
  /**
   * The apps, by id. The id may contain a-z, 0-9 and `-`. It is in the webhook URLs (`/eas/<id>`, `/asc/<id>`) and is
   * the `app` label routes match on.
   */
  apps: Record<string, ConfigApp>;
  /**
   * Adds the version number, the platform and a link to the app to App Store Connect messages. If the lookup fails,
   * the message is sent without them.
   */
  ascApi?: ConfigAscApi;
  /** The Google Play API credentials for every {@link ConfigApp.play}. */
  playApi?: ConfigPlayApi;
  /** Enables `/ingest`. */
  ingest?: ConfigIngest;
  /** Where messages are posted. At least one. */
  targets: (SlackTarget | DiscordTarget | TeamsTarget)[];
  /** Which events go to which targets. At least one. */
  routes: ConfigRoute[];
}

/** An app in {@link ConfigFile.apps}. */
export interface ConfigApp {
  /** The name shown in messages. */
  name: string;
  /** Receives EAS build and submission webhooks at `/eas/<id>`. */
  eas?: ConfigWebhook;
  /** Receives App Store Connect webhooks at `/asc/<id>`. */
  asc?: ConfigWebhook;
  /** Polls Google Play, which has no release webhooks. Ignored, with a warning at startup, unless {@link ConfigFile.playApi} is set. */
  play?: ConfigPlay;
}

/** A webhook source of a {@link ConfigApp}. */
export interface ConfigWebhook {
  /**
   * The secret the webhook is signed with. For EAS, the one passed to `eas webhook:create --secret` (16 or more
   * characters). For App Store Connect, the one set when creating the webhook.
   */
  secret: string;
}

/** The Google Play source of a {@link ConfigApp}. */
export interface ConfigPlay {
  /** The app's package name, such as `com.acme.myapp`. */
  packageName: string;
  /**
   * The tracks to watch, such as `[internal, production]`. A release published on `production` is a `release.live`
   * event, on any other track a `testing.build.available` event.
   */
  tracks: string[];
}

/** An App Store Connect API team key, from App Store Connect › Users and Access › Integrations › Team keys. The Developer role is enough. */
export interface ConfigAscApi {
  /** The Issuer ID shown above the keys list. */
  issuerId: string;
  /** The key's Key ID. */
  keyId: string;
  /** A path to the `.p8` key file, or the PEM itself. */
  privateKey: string;
}

/** A Google Cloud service account with read-only access to the apps in Play Console. */
export interface ConfigPlayApi {
  /** A path to the service account's JSON key file, or the JSON itself. */
  serviceAccount: string;
  /**
   * Whole minutes between polls, from 1 to 1440. After a poll where every track failed, the wait doubles, up to 60
   * minutes, until a track succeeds. A track that fails is logged at `error` level.
   * @default `15`
   */
  intervalMinutes?: number;
}

/** Settings for `POST /ingest`. The body is an {@link IngestEvent}. */
export interface ConfigIngest {
  /** The Standard Webhooks signing key: `whsec_` followed by at least 24 random bytes in base64. */
  secret: string;
}

/**
 * Sends the events that match it to targets. Every matching route fires. A target matched by several routes gets one
 * message, with a mention if any of them asks and silent only if all do.
 */
export interface ConfigRoute {
  /**
   * Event types: exact names, or a prefix ending in `*` such as `appreview.*` or `*`. An {@link IngestEvent} brings its
   * own, such as `update.published`. The built-in types:
   *
   * | Type | Severity | Source |
   * | --- | --- | --- |
   * | `build.succeeded`, `submit.succeeded` | `success` | EAS |
   * | `build.failed`, `submit.failed` | `error` | EAS |
   * | `build.canceled`, `submit.canceled` | `info` | EAS |
   * | `build.processing_failed` | `error` | App Store Connect |
   * | `testing.build.available` | `success` | App Store Connect, Google Play |
   * | `appreview.submitted` | `info` | App Store Connect |
   * | `appreview.in_review` | `info` | App Store Connect, Google Play |
   * | `appreview.approved` | `success` | App Store Connect, Google Play |
   * | `appreview.rejected` | `error` | App Store Connect, Google Play |
   * | `appreview.withdrawn` | `info` | App Store Connect |
   * | `release.live` | `success` | App Store Connect, Google Play |
   *
   * EAS sends no event when a build or submission starts.
   */
  types: string[];
  /**
   * Labels the event must have, matched exactly: `app` (the app id), `platform` (`ios`, `macos`, `tvos`, `visionos` or `android`), `profile` (the
   * EAS build profile), `track` (the Google Play track), or those of an {@link IngestEvent}.
   */
  labels?: Record<string, string>;
  /**
   * Drops events less severe than this, in the order `info`, `success`, `warning`, `error`.
   * @default `'info'`
   */
  minSeverity?: Severity;
  /** The ids of the targets to post to. */
  targets: string[];
  /**
   * Pings the target's `mention`.
   * @default `false`
   */
  mention?: boolean;
  /**
   * Posts without a push notification, on targets that support it ({@link DiscordTarget}).
   * @default `false`
   */
  silent?: boolean;
}

export interface AppConfig extends ConfigApp {
  id: string; // its key in ConfigFile.apps
}
export type Route = Required<ConfigRoute>;
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
  stateStore?: string;
  apps: Map<string, AppConfig>;
  ascApi?: AscApi;
  playApi?: PlayApi;
  ingest?: ConfigIngest;
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
    const a = obj(raw, w, keysOf<ConfigApp>({ name: true, eas: true, asc: true, play: true }));
    const eas = a.eas == null ? undefined : obj(a.eas, `${w}.eas`, keysOf<ConfigWebhook>({ secret: true }));
    const asc = a.asc == null ? undefined : obj(a.asc, `${w}.asc`, keysOf<ConfigWebhook>({ secret: true }));
    const play = a.play == null ? undefined : obj(a.play, `${w}.play`, keysOf<ConfigPlay>({ packageName: true, tracks: true }));
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
  const a = obj(v, 'ascApi', keysOf<ConfigAscApi>({ issuerId: true, keyId: true, privateKey: true }));
  const pem = inlineOrFile(str(a, 'privateKey', 'ascApi'), '-----BEGIN', baseDir, 'ascApi.privateKey');
  return { issuerId: str(a, 'issuerId', 'ascApi'), keyId: str(a, 'keyId', 'ascApi'), privateKey: createPrivateKey(pem) };
}

function parsePlayApi(v: unknown, baseDir: string): PlayApi {
  const p = obj(v, 'playApi', keysOf<ConfigPlayApi>({ serviceAccount: true, intervalMinutes: true }));
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
    intervalMinutes: int(p, 'intervalMinutes', 'playApi.', DEFAULTS.ConfigPlayApi.intervalMinutes, 1, 24 * 60),
  };
}

function parseIngest(v: unknown): ConfigIngest {
  const secret = str(obj(v, 'ingest', keysOf<ConfigIngest>({ secret: true })), 'secret', 'ingest');
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
    const r = obj(raw, w, keysOf<ConfigRoute>({ types: true, labels: true, minSeverity: true, targets: true, mention: true, silent: true }));
    const types = strList(r, 'types', w);
    for (const t of types) if (t.indexOf('*') !== -1 && t.indexOf('*') !== t.length - 1) throw new Error(`config: ${w}.types: "*" is only allowed at the end ("${t}")`);
    const ids = strList(r, 'targets', w);
    for (const id of ids) if (!targets.has(id)) throw new Error(`config: ${w}.targets: unknown target "${id}"`);
    const minSeverity = (r.minSeverity ?? DEFAULTS.ConfigRoute.minSeverity) as Severity;
    if (!(SEVERITIES as readonly string[]).includes(minSeverity)) throw new Error(`config: ${w}.minSeverity must be one of ${SEVERITIES.join(', ')}`);
    const labels = r.labels == null ? {} : obj(r.labels, `${w}.labels`);
    for (const k of Object.keys(labels)) str(labels, k, `${w}.labels`);
    return { types, labels: labels as Record<string, string>, minSeverity, targets: ids, mention: bool(r, 'mention', w, DEFAULTS.ConfigRoute.mention), silent: bool(r, 'silent', w, DEFAULTS.ConfigRoute.silent) };
  });
}

export function parseConfig(raw: unknown, baseDir = '.'): Config {
  const root = obj(raw, 'root', keysOf<ConfigFile>({ port: true, stateStore: true, apps: true, ascApi: true, playApi: true, ingest: true, targets: true, routes: true }));
  const targets = parseTargets(root.targets);
  return {
    port: int(root, 'port', '', DEFAULTS.ConfigFile.port, 1, 65535),
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
