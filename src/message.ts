export const SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** All text is plain text. Targets escape it for their own markup. */
export interface Message {
  id: string; // log correlation only (logged as msgId), not a dedup key
  type: string; // 'build.failed', 'appreview.rejected', ... (routing)
  source: string; // display name: 'EAS', 'App Store Connect', 'Google Play'
  severity: Severity;
  time?: string; // when it happened; the router normalizes it to ISO (now if missing or unparsable)
  title: string;
  body?: string; // may be multi-line
  actor?: string; // who triggered it
  fields?: { label: string; value: string }[];
  links?: { label: string; url: string }[]; // links[0] is primary: it also makes the title clickable
  labels: Record<string, string>; // routing only, never rendered
}
