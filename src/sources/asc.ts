// App Store Connect API webhooks: https://developer.apple.com/documentation/appstoreconnectapi/webhook-events
// Register only APP_STORE_VERSION_APP_VERSION_STATE_UPDATED and BUILD_UPLOAD_STATE_UPDATED; other types are ignored.
import { createHmac } from 'node:crypto';
import type { AppConfig, Config } from '../config.ts';
import { log } from '../log.ts';
import type { Message, Severity } from '../message.ts';
import { fetchJson, platformName, safeEq, signJwt } from './shared.ts';

interface AscEvent {
  data: {
    type: string;
    id: string;
    attributes?: null | { oldValue?: string; newValue?: string; newState?: string; timestamp?: string };
    relationships?: { instance?: { data?: { type: string; id: string } } };
  };
}
/** Filled in by an extra API call, because webhook payloads carry no version or app info. Optional. */
export interface AscDetails {
  version?: string; // "1.4.2" or "1.4.2 (57)"
  platform?: string; // IOS, MAC_OS, ...
  appleAppId?: string;
}

/** x-apple-signature: hmacsha256=<hex HMAC-SHA256 of the raw body> */
export const verifyAsc = (raw: Buffer, header: string | undefined, secret: string) =>
  !!header && safeEq(header, 'hmacsha256=' + createHmac('sha256', secret).update(raw).digest('hex'));

const REJECTED = ['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
// States a version can move to straight out of review when Apple accepts it (any release type: manual, automatic, scheduled).
const APPROVED_FROM_REVIEW = ['ACCEPTED', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_DISTRIBUTION'];

/** Abstract events for one AppVersionState change. Most states (PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW, ...) map to none. */
export function versionEvents(oldValue: string | undefined, newValue: string): { type: string; severity: Severity; what: string }[] {
  const out: { type: string; severity: Severity; what: string }[] = [];
  if (newValue === 'WAITING_FOR_REVIEW') out.push({ type: 'appreview.submitted', severity: 'info', what: 'submitted for review' });
  if (newValue === 'IN_REVIEW') out.push({ type: 'appreview.in_review', severity: 'info', what: 'in review' });
  if (REJECTED.includes(newValue)) out.push({ type: 'appreview.rejected', severity: 'error', what: newValue === 'METADATA_REJECTED' ? 'metadata rejected' : newValue === 'INVALID_BINARY' ? 'binary rejected' : 'rejected' });
  if (newValue === 'DEVELOPER_REJECTED') out.push({ type: 'appreview.withdrawn', severity: 'info', what: 'removed from review' });
  if (oldValue === 'IN_REVIEW' && APPROVED_FROM_REVIEW.includes(newValue)) out.push({ type: 'appreview.approved', severity: 'success', what: 'approved' });
  if (newValue === 'READY_FOR_DISTRIBUTION') out.push({ type: 'release.live', severity: 'success', what: 'live on the App Store' });
  return out;
}

export function ascToMessages(e: AscEvent, app: AppConfig, d: AscDetails = {}): Message[] {
  const { type, id } = e.data;
  const a = e.data.attributes ?? {}; // the undocumented test ping may have none, or null
  const platform = platformName(d.platform);
  const name = `${app.name}${d.version ? ` ${d.version}` : ''}`;
  const appUrl = d.appleAppId && `https://appstoreconnect.apple.com/apps/${d.appleAppId}`;
  const base = { source: 'App Store Connect', time: a.timestamp, labels: { app: app.id, platform: platform.toLowerCase() } };

  if (type === 'appStoreVersionAppVersionStateUpdated' && a.newValue) {
    return versionEvents(a.oldValue, a.newValue).map((ev) => ({
      ...base,
      id: `asc:${id}:${ev.type}`,
      type: ev.type,
      severity: ev.severity,
      title: `${platform} ${ev.what}: ${name}`,
      body: ev.type === 'appreview.rejected' ? 'Apple does not expose the reason via the API: see the App Review message in App Store Connect.' : undefined,
      links: [{ label: 'Open in App Store Connect', url: appUrl ? `${appUrl}/distribution` : 'https://appstoreconnect.apple.com/apps' }],
    }));
  }
  if (type === 'buildUploadStateUpdated' && (a.newState === 'COMPLETE' || a.newState === 'FAILED')) {
    const ok = a.newState === 'COMPLETE';
    return [{
      ...base,
      id: `asc:${id}`,
      type: ok ? 'testing.build.available' : 'build.processing_failed',
      severity: ok ? 'success' : 'error',
      title: ok ? `${platform} build processed, available in TestFlight: ${name}` : `${platform} build failed App Store Connect processing: ${name}`,
      links: [{ label: 'Open TestFlight', url: 'https://appstoreconnect.apple.com/apps' }], // buildUploads have no app id to deep-link
    }];
  }
  return [];
}

// ---- App Store Connect API (optional: version details)

type AscApi = NonNullable<Config['ascApi']>;
let token: { value: string; until: number } | undefined;

/** ES256 JWT for a team API key: valid 19 min (Apple allows 20), reused for 15. */
function jwt(api: AscApi): string {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.until > now) return token.value;
  const claims = { iss: api.issuerId, iat: now, exp: now + 1140, aud: 'appstoreconnect-v1' };
  // JWS wants the raw r||s signature, not DER
  token = { value: signJwt({ alg: 'ES256', kid: api.keyId, typ: 'JWT' }, claims, { key: api.privateKey, dsaEncoding: 'ieee-p1363' }), until: now + 900 };
  return token.value;
}

const ascFetch = (api: AscApi, path: string) =>
  fetchJson(`ASC API ${path.split('?')[0]}`, `https://api.appstoreconnect.apple.com${path}`,
    { headers: { authorization: `Bearer ${jwt(api)}`, 'content-type': 'application/json' } }, 3000); // short: the webhook reply waits on it

/** Best effort: a failed lookup just means the message has no version number. Never fails the delivery. */
export async function ascDetails(e: AscEvent, api: AscApi | undefined): Promise<AscDetails> {
  const inst = e.data.relationships?.instance?.data;
  if (!api || !inst) return {};
  try {
    if (inst.type === 'appStoreVersions') {
      const r = await ascFetch(api, `/v1/appStoreVersions/${encodeURIComponent(inst.id)}?fields[appStoreVersions]=versionString,platform,app&include=app&fields[apps]=bundleId`);
      return { version: r.data.attributes.versionString, platform: r.data.attributes.platform, appleAppId: r.data.relationships?.app?.data?.id };
    }
    if (inst.type === 'buildUploads') {
      const a = (await ascFetch(api, `/v1/buildUploads/${encodeURIComponent(inst.id)}`)).data.attributes;
      return { version: `${a.cfBundleShortVersionString} (${a.cfBundleVersion})`, platform: a.platform };
    }
  } catch (err) {
    log('warn', 'ASC details lookup failed, sending without them', { err: String(err) });
  }
  return {};
}
