import type { ConfigFile } from '../config.ts';
import { SEVERITY, type Target, bodyOf, fieldsOf, httpUrl, keysOf, linksOf, optStr, postJson, truncate } from './shared.ts';

/** A target in {@link ConfigFile.targets} that posts to a Slack incoming webhook. The bot's name and icon come from the Slack app. */
export interface SlackTarget {
  /** The id routes refer to it by. */
  id: string;
  /** Makes this a Slack target. */
  type: 'slack';
  /** The webhook URL, from the Slack app's Incoming Webhooks page. */
  url: string;
  /** What routes with `mention` ping, such as `<!subteam^S0123ABC>`, `<!here>` or `<@U0123>`. */
  mention?: string;
}

type SlackConfig = Pick<SlackTarget, 'url' | 'mention'>;

// mrkdwn has no escape for * _ ~. Only &<> matter: escaping them blocks injected <!channel> and <url|fake> links.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: string, max: number) => truncate(esc(s), max);
const safeUrl = (u: string) => u.replace(/[|<>]/g, encodeURIComponent); // these break <url|text>
const mrkdwn = (text: string) => ({ type: 'mrkdwn', text, verbatim: true }); // verbatim: no auto-linking of @here, #channel, urls

export const slack: Target<SlackConfig> = {
  keys: keysOf<Omit<SlackTarget, 'id' | 'type'>>({ url: true, mention: true }),
  parseConfig: (raw) => ({ url: httpUrl(raw, 'url').href, mention: optStr(raw, 'mention') }),

  render(m, cfg, d) {
    const { emoji, color } = SEVERITY[m.severity];
    const links = linksOf(m, 5, 3000);
    const body = bodyOf(m);
    const fields = fieldsOf(m, 10);
    const title = clip(m.title, 300);
    const unix = Math.floor(Date.parse(m.time!) / 1000); // router normalized it
    const context = [m.source, m.actor]
      .filter((s): s is string => !!s)
      .map((s) => clip(s, 100))
      .concat(`<!date^${unix}^{date_short_pretty} {time}|${m.time}>`) // viewer's timezone
      .join(' · ');

    return {
      // Top-level text is both the headline and the push-notification text.
      text: [d.mention && cfg.mention, `${emoji} *${links[0] ? `<${safeUrl(links[0].url)}|${title}>` : title}*`].filter(Boolean).join(' '),
      unfurl_links: false,
      unfurl_media: false,
      // Blocks live inside an attachment: it's the only way to get the colour bar.
      attachments: [
        {
          color: `#${color.toString(16).padStart(6, '0')}`,
          blocks: [
            ...(body ? [{ type: 'section', text: mrkdwn(clip(body, 3000)) }] : []),
            ...(fields.length
              ? [{ type: 'section', fields: fields.map((f) => mrkdwn(`*${clip(f.label, 100)}*\n${clip(f.value, 1800)}`)) }]
              : []),
            ...(links.length
              ? [{
                  type: 'actions',
                  elements: links.map((l) => ({ type: 'button', text: { type: 'plain_text', text: truncate(l.label, 75) }, url: l.url })),
                }]
              : []),
            { type: 'context', elements: [mrkdwn(context)] },
          ],
        },
      ],
    };
  },

  send: (payload, cfg) => postJson(cfg.url, payload),
};
