import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { parse } from 'yaml';
import { SEVERITIES, type Severity } from './message.ts';
import type { IngestEvent } from './sources/ingest.ts';
import { keysOf, type Target } from './targets/shared.ts';
import { slack, type SlackTarget } from './targets/slack.ts';
import { discord, type DiscordTarget } from './targets/discord.ts';
import { teams, type TeamsTarget } from './targets/teams.ts';
import { DEFAULTS } from './config.defaults.ts';

const TARGET_TYPES: Record<string, Target<any>> = { slack, discord, teams };

/**
 * The config file: YAML, read at startup. An unknown key fails startup, so a typo can't silently turn a filter off.
 *
 * `"${VAR}"` in a string value is replaced with the environment variable `VAR`, and startup fails when it's unset.
 * Quote it: inside `{ ... }` an unquoted `${VAR}` is a YAML syntax error. Relative paths resolve against the config
 * file's folder.
 */
export interface ConfigFile {
  /**
   * The port to listen on. A string such as `"${PORT}"` works too.
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
  /** Adds version numbers to App Store Connect messages. */
  ascApi?: ConfigAscApi;
  /** Required for {@link ConfigApp.play}. */
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
  /** Polls Google Play, which has no release webhooks. Needs {@link ConfigFile.playApi}. */
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
  issuerId: string;
  keyId: string;
  /** A path to the `.p8` key file, or the PEM itself. */
  privateKey: string;
}

/** A Google Cloud service account with read-only access to the apps in Play Console. */
export interface ConfigPlayApi {
  /** A path to the service account's JSON key file, or the JSON itself. */
  serviceAccount: string;
  /**
   * Minutes between polls, from 1 to 1440.
   * @default `15`
   */
  intervalMinutes?: number;
}

/** The `/ingest` endpoint, which takes an {@link IngestEvent} from any CI job or script. */
export interface ConfigIngest {
  /** The Standard Webhooks signing key: `whsec_` followed by at least 24 random bytes in base64. */
  secret: string;
}

/** Sends the events that match it to targets. Every matching route fires, and a target matched by several routes gets one message. */
export interface ConfigRoute {
  /**
   * Event types: exact names, or a prefix ending in `*` such as `appreview.*` or `*`. The built-in types are
   * `build.succeeded`, `build.failed`, `build.canceled`, `submit.succeeded`, `submit.failed`, `submit.canceled`,
   * `build.processing_failed`, `testing.build.available`, `appreview.submitted`, `appreview.in_review`,
   * `appreview.approved`, `appreview.rejected`, `appreview.withdrawn` and `release.live`. An {@link IngestEvent} brings
   * its own, such as `update.published`.
   */
  types: string[];
  /**
   * Labels the event must have, matched exactly: `app` (the app id), `platform` (`ios` or `android`), `profile` (the
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
function bool(o: Obj, k: string, where: string, fallback: boolean): boolean {
  const v = o[k] ?? fallback;
  if (v === false || v === 'false') return false;
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
  const root = obj(raw, 'root', keysOf<ConfigFile>({ port: true, stateStore: true, apps: true, ascApi: true, playApi: true, ingest: true, targets: true, routes: true }));

  const apps = new Map<string, AppConfig>();
  for (const [id, v] of Object.entries(obj(root.apps, 'apps'))) {
    const w = `apps.${id}`;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`config: app id "${id}" may only contain a-z, 0-9 and -`);
    const a = obj(v, w, keysOf<ConfigApp>({ name: true, eas: true, asc: true, play: true }));
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

  let ascApi: Config['ascApi'];
  if (root.ascApi != null) {
    const a = obj(root.ascApi, 'ascApi', keysOf<ConfigAscApi>({ issuerId: true, keyId: true, privateKey: true }));
    const pem = inlineOrFile(str(a, 'privateKey', 'ascApi'), '-----BEGIN', baseDir, 'ascApi.privateKey');
    ascApi = { issuerId: str(a, 'issuerId', 'ascApi'), keyId: str(a, 'keyId', 'ascApi'), privateKey: createPrivateKey(pem) };
  }

  let playApi: Config['playApi'];
  if (root.playApi != null) {
    const p = obj(root.playApi, 'playApi', keysOf<ConfigPlayApi>({ serviceAccount: true, intervalMinutes: true }));
    let sa;
    try {
      sa = JSON.parse(inlineOrFile(str(p, 'serviceAccount', 'playApi'), '{', baseDir, 'playApi.serviceAccount'));
    } catch (err) {
      // JSON.parse errors quote the start of the text, which here is a private key.
      throw (err as Error).message.startsWith('config:') ? err : new Error('config: playApi.serviceAccount is not valid JSON');
    }
    if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') throw new Error('config: playApi.serviceAccount is not a service-account key JSON');
    const interval = p.intervalMinutes ?? DEFAULTS.ConfigPlayApi.intervalMinutes;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 1 || interval > 24 * 60) throw new Error('config: playApi.intervalMinutes must be a number from 1 to 1440');
    playApi = { serviceAccount: sa, intervalMinutes: interval };
  }

  let ingest: Config['ingest'];
  if (root.ingest != null) {
    const secret = str(obj(root.ingest, 'ingest', keysOf<ConfigIngest>({ secret: true })), 'secret', 'ingest');
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
    const r = obj(v, w, keysOf<ConfigRoute>({ types: true, labels: true, minSeverity: true, targets: true, mention: true, silent: true }));
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

  const port = Number(root.port ?? DEFAULTS.ConfigFile.port); // a string from "${PORT}" too
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
