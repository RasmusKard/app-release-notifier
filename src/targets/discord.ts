import type { ConfigFile } from '../config.ts';
import { SEVERITY, type Target, bodyOf, fieldsOf, httpUrl, keysOf, linksOf, optStr, postJson, truncate } from './shared.ts';

/** A target in {@link ConfigFile.targets} that posts to a Discord webhook. Its name and avatar are set on the webhook in Discord. */
export interface DiscordTarget {
  /** The id routes refer to it by. */
  id: string;
  type: 'discord';
  /** The webhook URL, from the channel's Integrations › Webhooks. */
  url: string;
  /** What routes with `mention` ping, such as `<@&roleId>`, `<@userId>` or `@here`. */
  mention?: string;
  /** Posts into this thread or forum post. */
  threadId?: string;
}

type DiscordConfig = Pick<DiscordTarget, 'url' | 'mention'>; // threadId goes into the url

// Escape markdown only in slots that render it (title, description, field values). Footer and author are plain text.
// Bare URLs are left alone (escaping _ inside them breaks the link). Escaping [ ] is enough to break [text](url).
const URL_RE = /(https?:\/\/[^\s<>]+)/;
const esc = (s: string) =>
  s
    .split(URL_RE)
    .map((part, i) => (i % 2 ? part : part.replace(/[\\*_~`|<>[\]]/g, '\\$&')))
    .join('')
    .replace(/^(\s*)([#-])/gm, '$1\\$2') // headings, bullets, subtext at line start
    .replace(/^(\s*\d+)\.(?=\s)/gm, '$1\\.'); // numbered lists: `1\.` (a backslash before a digit would show literally)
const clip = (s: string, max: number) => truncate(esc(s), max);

export const discord: Target<DiscordConfig> = {
  keys: keysOf<Omit<DiscordTarget, 'id' | 'type'>>({ url: true, mention: true, threadId: true }),
  parseConfig(raw) {
    // URLs from the Discord UI carry no version, so they hit deprecated v6.
    // wait=true makes failures visible and returns the message id. with_components enables link buttons.
    const url = httpUrl(raw, 'url');
    url.pathname = url.pathname.replace(/\/api\/(v\d+\/)?webhooks\//, '/api/v10/webhooks/');
    url.searchParams.set('wait', 'true');
    url.searchParams.set('with_components', 'true');
    const threadId = optStr(raw, 'threadId');
    if (threadId) url.searchParams.set('thread_id', threadId);
    return { url: url.toString(), mention: optStr(raw, 'mention') };
  },

  render(m, cfg, d) {
    const { emoji, color } = SEVERITY[m.severity];
    const links = linksOf(m, 5, 512); // link buttons reject longer URLs
    const body = bodyOf(m);
    // Fixed caps keep all embeds under Discord's 6000-char total without measuring: 256 + 2000 + 10×(64+256) + 256 + 100 = 5812
    return {
      content: d.mention ? cfg.mention : undefined,
      allowed_mentions: { parse: d.mention ? ['users', 'roles', 'everyone'] : [] }, // embeds never ping; content only holds our mention
      flags: d.silent ? 4096 : undefined, // SUPPRESS_NOTIFICATIONS
      embeds: [
        {
          title: clip(`${emoji} ${m.title}`, 256),
          url: links[0]?.url,
          description: body ? clip(body, 2000) : undefined,
          color,
          fields: fieldsOf(m, 10).map((f) => ({ name: truncate(f.label, 64), value: clip(f.value, 256), inline: true })),
          author: m.actor ? { name: truncate(m.actor, 256) } : undefined,
          footer: { text: truncate(m.source, 100) },
          timestamp: m.time, // shown in the viewer's timezone (router normalized it)
        },
      ],
      components: links.length
        ? [{ type: 1, components: links.map((l) => ({ type: 2, style: 5, label: truncate(l.label, 80), url: l.url })) }]
        : undefined,
    };
  },

  send: (payload, cfg) => postJson(cfg.url, payload),
};
