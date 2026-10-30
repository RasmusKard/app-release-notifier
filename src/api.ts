// The TypeDoc site's entry point: what operators write (the config file) and send (/ingest), not the internals.
export type { ConfigApp, ConfigAscApi, ConfigFile, ConfigIngest, ConfigPlay, ConfigPlayApi, ConfigRoute, ConfigWebhook } from './config.ts';
export type { IngestEvent } from './sources/ingest.ts';
export type { DiscordTarget } from './targets/discord.ts';
export type { SlackTarget } from './targets/slack.ts';
export type { TeamsTarget } from './targets/teams.ts';
