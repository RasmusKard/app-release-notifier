// EAS webhooks: https://docs.expo.dev/eas/webhooks/
import { createHmac } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import type { Message, Severity } from '../message.ts';
import { platformName, safeEq } from './shared.ts';

type EasStatus = 'finished' | 'errored' | 'canceled';
interface EasError {
  message: string;
  errorCode: string;
}
interface EasBuild {
  id: string;
  buildDetailsPageUrl: string;
  platform: 'ios' | 'android';
  status: EasStatus;
  artifacts?: { buildUrl?: string };
  metadata?: {
    appVersion?: string;
    appBuildVersion?: string;
    buildProfile?: string;
    distribution?: string;
    gitCommitHash?: string;
    gitCommitMessage?: string;
    channel?: string;
    username?: string;
  };
  error?: EasError;
  completedAt?: string;
}
interface EasSubmit {
  id: string;
  submissionDetailsPageUrl: string;
  platform: 'ios' | 'android';
  status: EasStatus;
  submissionInfo?: { error?: EasError; logsUrl?: string };
  completedAt?: string;
}

export const verifyEas = (raw: Buffer, header: string | undefined, secret: string) =>
  !!header && safeEq(header, 'sha1=' + createHmac('sha1', secret).update(raw).digest('hex'));

const OUTCOME: Record<EasStatus, { verb: string; suffix: string; severity: Severity }> = {
  finished: { verb: 'succeeded', suffix: 'succeeded', severity: 'success' },
  errored: { verb: 'failed', suffix: 'failed', severity: 'error' },
  canceled: { verb: 'was canceled', suffix: 'canceled', severity: 'info' },
};
const errorText = (e: EasError | undefined) => e && `${e.message} (${e.errorCode})`;

/** Signed by Expo, so trust the shape; check only what decides the message type and title. */
export const isEasPayload = (p: any): p is EasBuild | EasSubmit =>
  !!p && typeof p.id === 'string' && Object.hasOwn(OUTCOME, p.status) && (p.platform === 'ios' || p.platform === 'android') &&
  (typeof p.buildDetailsPageUrl === 'string' || typeof p.submissionDetailsPageUrl === 'string');

// Same discriminator as isEasPayload, so a build body with `submissionDetailsPageUrl: null` stays a build.
const isSubmit = (p: EasBuild | EasSubmit): p is EasSubmit => typeof (p as EasSubmit).submissionDetailsPageUrl === 'string';

export function easToMessages(p: EasBuild | EasSubmit, app: AppConfig): Message[] {
  const o = OUTCOME[p.status];
  const platform = platformName(p.platform);
  const base = { source: 'EAS', severity: o.severity, time: p.completedAt };

  if (isSubmit(p)) {
    const store = p.platform === 'ios' ? 'App Store Connect' : 'Google Play';
    return [{
      ...base,
      id: `eas:submit:${p.id}:${p.status}`,
      type: `submit.${o.suffix}`,
      title: `${platform} submission to ${store} ${o.verb}: ${app.name}`,
      body: errorText(p.submissionInfo?.error),
      links: [
        { label: 'View submission', url: p.submissionDetailsPageUrl },
        ...(p.submissionInfo?.logsUrl ? [{ label: 'Logs', url: p.submissionInfo.logsUrl }] : []),
      ],
      labels: { app: app.id, platform: p.platform },
    }];
  }

  const md = p.metadata ?? {};
  const version = [md.appVersion, md.appBuildVersion && `(${md.appBuildVersion})`].filter(Boolean).join(' ');
  return [{
    ...base,
    id: `eas:build:${p.id}:${p.status}`,
    type: `build.${o.suffix}`,
    title: `${platform} build ${o.verb}: ${app.name}${version ? ` ${version}` : ''}`,
    body: errorText(p.error),
    actor: md.username,
    fields: [
      ...(md.buildProfile ? [{ label: 'Profile', value: md.buildProfile }] : []),
      ...(md.gitCommitHash ? [{ label: 'Commit', value: `${md.gitCommitHash.slice(0, 7)} ${(md.gitCommitMessage ?? '').split('\n')[0]}`.trim() }] : []),
      ...(md.channel ? [{ label: 'Channel', value: md.channel }] : []),
    ],
    links: [
      { label: 'View build', url: p.buildDetailsPageUrl },
      ...(p.status === 'finished' && p.artifacts?.buildUrl ? [{ label: 'Download', url: p.artifacts.buildUrl }] : []),
    ],
    labels: { app: app.id, platform: p.platform, ...(md.buildProfile && { profile: md.buildProfile }) },
  }];
}
