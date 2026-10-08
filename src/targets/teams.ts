import { SEVERITY, type Target, bodyOf, fieldsOf, httpUrl, linksOf, postJson, truncate } from './shared.ts';

interface TeamsConfig {
  url: string;
  mention?: { id: string; name: string }; // id: Entra object id or UPN
}

const STYLE = { info: 'accent', success: 'good', warning: 'warning', error: 'attention' } as const;
// DATE()/TIME() render raw unless given strict RFC 3339 (no milliseconds). The router already normalized time to ISO.
const rfc3339 = (iso = '') => iso.replace(/\.\d{3}Z$/, 'Z');
// TextBlock parses markdown, so [text](url) in source text would become a link. Untrusted text goes in TextRuns, which don't.
const rich = (text: string, style: Record<string, unknown> = {}) => ({ type: 'RichTextBlock', inlines: [{ type: 'TextRun', text, ...style }] });

export const teams: Target<TeamsConfig> = {
  keys: ['url', 'mention'],
  parseConfig(raw) {
    const url = httpUrl(raw, 'url');
    if (/\.(logic\.azure|webhook\.office)\.com$/.test(url.hostname)) // hostname: lower-cased, no :443
      throw new Error('teams URL is a retired O365 connector / old Workflows host; create a new Workflows webhook');
    const mention = raw.mention as Record<string, unknown> | undefined;
    if (mention != null && (typeof mention.id !== 'string' || typeof mention.name !== 'string' || Object.keys(mention).length !== 2))
      throw new Error('teams "mention" needs string "id" and "name" and nothing else');
    return { url: url.href, mention: mention as TeamsConfig['mention'] };
  },

  // Teams drops cards over 28 KB after replying 202, so we'd never know. These caps keep the worst case
  // (3-byte UTF-8 text in every slot, 6 links of 2048 chars) at about 26 KB.
  render(m, cfg, d) {
    const links = linksOf(m, 6, 2048);
    const fields = fieldsOf(m, 6);
    const body = bodyOf(m);
    const at = d.mention ? cfg.mention : undefined;
    const t = rfc3339(m.time);
    const small = { isSubtle: true, size: 'Small' };

    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4', // Flow bot often fails to render cards declared 1.5
            msteams: { width: 'Full', ...(at ? { entities: [{ type: 'mention', text: `<at>${at.name}</at>`, mentioned: at }] } : {}) },
            body: [
              {
                type: 'Container',
                style: STYLE[m.severity],
                bleed: true,
                selectAction: links[0] ? { type: 'Action.OpenUrl', url: links[0].url } : undefined,
                items: [rich(`${SEVERITY[m.severity].emoji} ${truncate(m.title, 300)}`, { weight: 'Bolder', size: 'Medium' })],
              },
              ...(at ? [{ type: 'TextBlock', text: `<at>${at.name}</at>`, wrap: true }] : []), // name comes from our config
              ...(body ? [rich(truncate(body, 1000))] : []),
              ...fields.map((f) => ({
                type: 'RichTextBlock',
                inlines: [
                  { type: 'TextRun', text: `${truncate(f.label, 64)}: `, weight: 'Bolder' },
                  { type: 'TextRun', text: truncate(f.value, 200) },
                ],
              })),
              {
                // Two columns because DATE()/TIME() are documented for TextBlock only, and the actor must not go in a TextBlock.
                type: 'ColumnSet',
                columns: [
                  { type: 'Column', width: 'auto', items: [rich([truncate(m.source, 100), m.actor && truncate(m.actor, 100)].filter(Boolean).join(' · ') + ' ·', small)] },
                  { type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: `{{DATE(${t},SHORT)}} {{TIME(${t})}}`, wrap: true, ...small }] },
                ],
              },
            ],
            actions: links.map((l) => ({ type: 'Action.OpenUrl', title: truncate(l.label, 40), url: l.url })),
          },
        },
      ],
    };
  },

  send: (payload, cfg) => postJson(cfg.url, payload),
};
