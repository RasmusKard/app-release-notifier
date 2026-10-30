# storeherald

**A server that posts an Expo app's builds, store reviews and releases to Slack, Discord and Microsoft Teams.**

Routes in `config.yaml` pick which events go where:

```yaml
routes:
  - types: ["build.failed", "submit.failed", "appreview.rejected"]
    targets: [releases, teams]
    mention: true
  - types: ["*"]
    targets: [dev-discord]
    silent: true
```

The [config reference](https://rasmuskard.github.io/storeherald/interfaces/ConfigFile.html) lists every option and event type. [`config.example.yaml`](config.example.yaml) is a starting point.

When a target is down:

- If no target got the event, the server replies 503. EAS resends it a few times, an `/ingest` caller should resend it, and App Store Connect needs a resend by hand (see [Limits](#limits)). The Google Play poller retries on its next poll.
- If another target got it, the sender isn't asked to resend. The failure is logged at `error` level.
- A message can occasionally be posted twice: a post that timed out is retried even if it landed, and a resent event repeats its messages that did get through.

## Install

Run the Docker image, `ghcr.io/rasmuskard/storeherald`, for `linux/amd64` and `linux/arm64`. It's tagged with each release's version (`1.2.3`, `1.2`, `1`) and `latest`.

Or run from source, with Node 24 or later. It runs the TypeScript directly, with no build step:

```sh
git clone https://github.com/RasmusKard/storeherald.git
cd storeherald
npm ci
```

## Usage

1. Write the config: your apps, targets and routes. Start from [`config.example.yaml`](config.example.yaml) and remove the sources you don't use: every `${VAR}` must be set and every key file must exist.
2. Put the variables the config references in `.env`, then start the server.

   With Docker Compose, the config can live in `compose.yml`:

   ```yaml
   services:
     storeherald:
       image: ghcr.io/rasmuskard/storeherald
       ports: ["8080:8080"]
       env_file: .env
       configs:
         - source: storeherald
           target: /config/config.yaml

   configs:
     storeherald:
       content: |
         apps:
           myapp:
             name: My App
             eas: { secret: "$${EAS_WEBHOOK_SECRET}" }
         targets:
           - { id: releases, type: slack, url: "$${SLACK_RELEASES_WEBHOOK}" }
         routes:
           - { types: ["*"], targets: [releases] }
   ```

   Compose replaces `${VAR}` in `content` itself, so write `$${VAR}` there. The server then reads the value from its environment, and `compose.yml` holds no secrets. Key files can be more `configs`, or the key itself can go in a variable.

   Or with `docker run`, mounting the folder that holds `config.yaml` and its key files at `/config`:

   ```sh
   docker run --env-file .env -p 8080:8080 -v "$PWD:/config:ro" ghcr.io/rasmuskard/storeherald
   ```

   Or from source:

   ```sh
   node --env-file=.env src/main.ts config.yaml
   ```

   On a host that can't mount a file, put the YAML in the `STOREHERALD_CONFIG` environment variable instead.

3. [Connect the sources](#sources).
4. Logs are JSON lines on stdout. Alert on those with `"level":"error"` and point your uptime check at `GET /health_check`.

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

Add [`ascApi`](https://rasmuskard.github.io/storeherald/interfaces/ConfigAscApi.html) to the config to get version numbers in messages.

### Google Play

The server polls Play every [`playApi.intervalMinutes`](https://rasmuskard.github.io/storeherald/interfaces/ConfigPlayApi.html). The first poll only records the current state. Messages start with the next change.

- In a Google Cloud project, enable the *Google Play Android Developer API*.
- Create a service account in that project and download its JSON key.
- Invite it in Play Console › Users and permissions with read-only access to the app.

### Custom events

`/ingest` takes events from any CI job or script, for example after publishing an OTA update (EAS has no webhook for those).

- Set `ingest.secret` in the config. Generate one with `node -e 'console.log("whsec_"+require("crypto").randomBytes(32).toString("base64"))'`.
- Sign each request with [Standard Webhooks](https://www.standardwebhooks.com/). Its libraries do this, or see the example below.
- The JSON body is an [`IngestEvent`](https://rasmuskard.github.io/storeherald/interfaces/IngestEvent.html).
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

[`slack`](https://rasmuskard.github.io/storeherald/interfaces/SlackTarget.html), [`discord`](https://rasmuskard.github.io/storeherald/interfaces/DiscordTarget.html) and [`teams`](https://rasmuskard.github.io/storeherald/interfaces/TeamsTarget.html), each with its options and where its webhook URL comes from.

## State

To keep Google Play's seen release states across restarts, point [`stateStore`](https://rasmuskard.github.io/storeherald/interfaces/ConfigFile.html#statestore) in the config at a module like this one.

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

## License

MIT
