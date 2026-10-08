// Google Play has no webhooks for releases: poll tracks.releases.list for releaseLifecycleState.
// https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppConfig, Config, PlayApi } from '../config.ts';
import { errText, log } from '../log.ts';
import type { Message } from '../message.ts';
import type { Router } from '../router.ts';
import type { StateStore } from '../state.ts';
import { fetchJson, signJwt, type StateEvent } from './shared.ts';

export interface PlayRelease {
  releaseName?: string;
  releaseLifecycleState?: string;
  activeArtifacts?: { versionCode?: string | number }[];
}
/** `${packageName}/${track}` -> releaseKey -> lifecycle state */
export type PlayState = Record<string, Record<string, string>>;

const EVENTS: Record<string, StateEvent> = {
  RELEASE_LIFECYCLE_STATE_IN_REVIEW: { type: 'appreview.in_review', severity: 'info', what: 'in review' },
  RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: { type: 'appreview.approved', severity: 'success', what: 'approved, not yet published' },
  RELEASE_LIFECYCLE_STATE_NOT_APPROVED: { type: 'appreview.rejected', severity: 'error', what: 'rejected' },
};

/**
 * Compare one track's releases with what we saw last time. `prev === undefined` (first poll of this track) records a
 * baseline and notifies nothing, so existing releases don't flood the channels.
 */
export function playDiff(prev: Record<string, string> | undefined, releases: PlayRelease[], app: AppConfig, track: string) {
  const next: Record<string, string> = {};
  const messages: Message[] = [];
  for (const r of releases) {
    const state = r.releaseLifecycleState;
    if (!state) continue;
    const codes = (r.activeArtifacts ?? []).map((a) => String(a.versionCode)).join(',');
    const key = `${r.releaseName ?? ''}|${codes}`;
    next[key] = state;
    if (!prev || prev[key] === state) continue;

    const ev: StateEvent | undefined =
      state === 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
        ? track === 'production'
          ? { type: 'release.live', severity: 'success', what: 'live on Google Play' }
          : { type: 'testing.build.available', severity: 'success', what: `available on the ${track} track` }
        : EVENTS[state];
    if (!ev) continue; // DRAFT, NOT_SENT_FOR_REVIEW, UNSPECIFIED
    const pkg = app.play!.packageName;
    messages.push({
      id: `play:${pkg}:${track}:${key}:${state}`,
      type: ev.type,
      source: 'Google Play',
      severity: ev.severity,
      title: `Android ${ev.what}: ${app.name} ${r.releaseName ?? codes}`.trim(),
      body: ev.type === 'appreview.rejected' ? 'Google sends the reason by email and in the Play Console inbox.' : undefined,
      fields: [{ label: 'Track', value: track }, ...(codes ? [{ label: 'Version code', value: codes }] : [])],
      links: [{ label: 'Open Play Console', url: 'https://play.google.com/console' }],
      labels: { app: app.id, platform: 'android', track },
    });
  }
  return { next, messages };
}

let token: { value: string; until: number } | undefined;

/** Service-account JWT exchanged for an OAuth token, cached until 5 min before expiry. */
async function accessToken(api: PlayApi): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.until > now) return token.value;
  const sa = api.serviceAccount;
  const claims = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const assertion = signJwt({ alg: 'RS256', typ: 'JWT' }, claims, sa.private_key);
  const t: { access_token: string; expires_in: number } = await fetchJson('Google token', 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  token = { value: t.access_token, until: now + t.expires_in - 300 };
  return token.value;
}

async function listReleases(api: PlayApi, pkg: string, track: string): Promise<PlayRelease[]> {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/tracks/${encodeURIComponent(track)}/releases`;
  const r: { releases?: PlayRelease[] } = await fetchJson(`Play releases ${pkg}/${track}`, url, { headers: { authorization: `Bearer ${await accessToken(api)}` } }, 15_000);
  return r.releases ?? [];
}

export function startPlayPoller(cfg: Pick<Config, 'playApi' | 'apps'>, router: Router, store: StateStore, signal: AbortSignal) {
  const api = cfg.playApi;
  const apps = [...cfg.apps.values()].filter((a) => a.play);
  if (!api) for (const a of apps) log('warn', 'app has play settings but there is no playApi: Google Play is not polled', { app: a.id });
  if (!api || !apps.length) return;
  const tracks = apps.flatMap((app) => app.play!.tracks.map((track) => ({ app, track, key: `${app.play!.packageName}/${track}` })));
  const baseMs = api.intervalMinutes * 60_000;

  (async () => {
    let state: PlayState | undefined;
    let delay = baseMs;
    while (!signal.aborted) {
      let failures = 0;
      // A failed load must not count as "no state", or the save below would overwrite good state with a baseline.
      state ??= await store.get('play-state').then((raw) => JSON.parse(raw ?? '{}') as PlayState).catch((err) => {
        log('error', 'could not load Play state (fix or clear the stored value), skipping this poll', { err: String(err) });
        return undefined;
      });
      if (!state) failures = tracks.length;
      else {
        for (const { app, track, key } of tracks) {
          try {
            const { next, messages } = playDiff(state[key], await listReleases(api, app.play!.packageName, track), app, track);
            // Only remember the new state once it's delivered; otherwise the next poll tries again.
            if ((await router.deliver(messages)) === 'ok') state[key] = next;
            else failures++;
          } catch (err) {
            failures++;
            log('error', 'Play poll failed', { track: key, err: errText(err) });
          }
        }
      }
      if (state) await store.set('play-state', JSON.stringify(state)).catch((err) => log('error', 'could not save Play state', { err: String(err) }));
      // Back off up to 1 h only when every track failed (quota errors come back as 403/429), so one broken app can't slow the rest.
      delay = failures === tracks.length ? Math.max(baseMs, Math.min(delay * 2, 60 * 60_000)) : baseMs;
      await sleep(delay, undefined, { signal }).catch(() => {});
    }
  })();
}
