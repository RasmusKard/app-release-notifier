# storeherald

**A server that posts an Expo app's builds, store reviews and releases to Slack, Discord and Microsoft Teams.**

Routes in `config.yaml` pick which events go where:

```yaml
routes:
  - types: ["build.failed", "submit.failed", "appreview.rejected"]
    targets: [releases, teams]
    mention: true # pings the target's configured mention
  - types: ["*"]
    targets: [dev-discord]
    silent: true
```

[`config.example.yaml`](config.example.yaml) lists every event type and option.

When a target is down:

- If no other target got the event, the sender is asked to resend it (HTTP 503). The Google Play poller retries on its next poll.
- If another target got it, it isn't resent, so nothing is posted twice. The failure is logged at `error` level.

## Install

```sh
git clone https://github.com/RasmusKard/storeherald.git
cd storeherald
npm ci
```

_Node 24 or later. Runs the TypeScript directly, with no build step._

## Usage

1. Copy the config and fill in your apps, targets and routes:

   ```sh
   cp config.example.yaml config.yaml
   ```

2. Start the server:

   ```sh
   node --env-file=.env src/main.ts config.yaml
   ```

   Or with Docker: `docker build -t storeherald .`, then mount the folder holding `config.yaml` and its key files at `/config`.

3. [Connect the sources](#sources).
4. Alert on `error`-level log lines (failed deliveries) and point your uptime check at `GET /health_check`.

## Sources

### EAS builds and submissions

`/eas/<app>`:

```sh
eas webhook:create --event BUILD --url https://your.host/eas/myapp --secret "$EAS_WEBHOOK_SECRET"
eas webhook:create --event SUBMIT --url https://your.host/eas/myapp --secret "$EAS_WEBHOOK_SECRET"
```

### App Store Connect

`/asc/<app>`: in App Store Connect › Users and Access › Integrations › Webhooks, create one webhook per app.

- URL: `https://your.host/asc/myapp`.
- Secret: the one in `config.yaml`.
- Events: *App Store version state changes* and *Build upload state changes*.

Add `ascApi` to the config to get version numbers in messages.

### Google Play

Play has no release webhooks, so the server polls it every `intervalMinutes`. The first poll only records the current state. Messages start with the next change.

- In a Google Cloud project, enable the *Google Play Android Developer API*.
- Create a service account in that project and download its JSON key.
- Invite it in Play Console › Users and permissions with read-only access to the app.

### Custom events

`/ingest` takes events from any CI job or script, for example after publishing an OTA update (EAS has no webhook for those).

- Set `ingest.secret` in the config. Generate one with `node -e 'console.log("whsec_"+require("crypto").randomBytes(32).toString("base64"))'`.
- Sign each request with [Standard Webhooks](https://www.standardwebhooks.com/). Its libraries do this, or see the example below.
- The JSON body needs `type` (like `update.published`) and `title`. Optional: `severity`, `body`, `actor`, `source`, `time`, `fields`, `links`, and `labels` such as `{ "app": "myapp" }` for routes to match on.
- Resend on a 503.

<details>
<summary>Posting an event from Node</summary>

```js
// post-event.mjs: node post-event.mjs '{"type":"update.published","title":"OTA update published"}'
import { createHmac, randomUUID } from 'node:crypto';
const body = process.argv[2];
const id = `msg_${randomUUID()}`, ts = String(Math.floor(Date.now() / 1000));
const key = Buffer.from(process.env.INGEST_SECRET.replace(/^whsec_/, ''), 'base64');
const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
const res = await fetch(process.env.INGEST_URL, {
  method: 'POST',
  body,
  headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` },
});
if (!res.ok) throw new Error(`ingest: ${res.status} ${await res.text()}`);
```

</details>

## Targets

| Type | URL from | Notes |
| --- | --- | --- |
| `slack` | Slack app › Incoming Webhooks | The bot name and icon come from the Slack app. |
| `discord` | Channel › Integrations › Webhooks | `silent` routes suppress push notifications. `threadId` posts into a thread or forum post. |
| `teams` | Teams Workflows › "Send webhook alerts to a channel" | Teams accepts posts before delivering them, so failures only show in the flow's run history. Limit is roughly 25 posts per 5 minutes. |

## State

The Google Play poller remembers which release states it has seen. By default it keeps them in memory. To keep them across restarts, point `stateStore` in the config at a module that exports `get(key)` and `set(key, value)`, both with string values. `get` returns `undefined` when nothing is stored and throws on errors, which skips that poll.

<details>
<summary>A file on disk</summary>

```js
// state-store.mjs: a file on disk. In Docker, set STATE_DIR to a mounted volume (the app folder isn't writable).
import { readFile, rename, writeFile } from 'node:fs/promises';
const file = (key) => `${process.env.STATE_DIR ?? '.'}/${key}.json`;
export const get = (key) => readFile(file(key), 'utf8').catch((e) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
export const set = async (key, value) => {
  await writeFile(`${file(key)}.tmp`, value);
  await rename(`${file(key)}.tmp`, file(key)); // atomic: a crash mid-write can't leave a half-written file
};
```

</details>

To use Redis, a database or another remote store instead, export the same `get` and `set` backed by it.

## Limits

- Google Play changes made while the server is down are missed unless you configure a [state store](#state).
- If you use Google Play, run a single instance. Each instance polls, so two would post every change twice.
- Google Play rejection reasons aren't in its API. They arrive by email.
- If every target was down when an App Store Connect event arrived, resend it by hand from the webhook's delivery list in App Store Connect.

