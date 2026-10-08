import { createServer, type IncomingMessage } from 'node:http';
import { loadConfig, type Config } from './config.ts';
import { log } from './log.ts';
import { createRouter } from './router.ts';
import type { Message } from './message.ts';
import { ascMessages, isAscEvent, verifyAsc } from './sources/asc.ts';
import { easToMessages, isEasPayload, verifyEas } from './sources/eas.ts';
import { ingestToMessage, verifyIngest } from './sources/ingest.ts';
import { startPlayPoller } from './sources/play.ts';
import { loadStateStore } from './state.ts';

const MAX_BODY = 1024 * 1024;

// Its own class, so only errors meant for the sender reach the response: delivery errors can quote a target's reply.
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const httpError = (status: number, message: string) => new HttpError(status, message);

/** Raw bytes, needed for HMAC checks. Capped: Node has no default body limit. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw httpError(413, 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'body too large'); // chunked uploads have no content-length
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(raw: Buffer): any {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON');
  }
}

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Verify the signature on the raw bytes before parsing. */
async function handle(cfg: Config, req: IncomingMessage, path: string[]): Promise<Message[]> {
  const [source, appId] = path;
  const raw = await readBody(req);

  if (source === 'ingest' && path.length === 1) {
    if (!cfg.ingest) throw httpError(404, 'not found');
    const h = { id: header(req, 'webhook-id'), timestamp: header(req, 'webhook-timestamp'), signature: header(req, 'webhook-signature') };
    if (!verifyIngest(raw, h, cfg.ingest.secret)) throw httpError(401, 'bad signature');
    const m = ingestToMessage(h.id!, json(raw));
    if (typeof m === 'string') throw httpError(400, m);
    return [m];
  }

  const app = appId ? cfg.apps.get(appId) : undefined;
  if (path.length !== 2 || !app) throw httpError(404, 'not found');

  if (source === 'eas' && app.eas) {
    if (!verifyEas(raw, header(req, 'expo-signature'), app.eas.secret)) throw httpError(401, 'bad signature');
    const payload = json(raw);
    if (!isEasPayload(payload)) throw httpError(400, 'not an EAS build or submission webhook');
    return easToMessages(payload, app);
  }
  if (source === 'asc' && app.asc) {
    if (!verifyAsc(raw, header(req, 'x-apple-signature'), app.asc.secret)) throw httpError(401, 'bad signature');
    const event = json(raw);
    if (!isAscEvent(event)) throw httpError(400, 'not an App Store Connect event');
    return ascMessages(event, app, cfg.ascApi);
  }
  throw httpError(404, 'not found');
}

async function main() {
  const cfg = loadConfig(process.argv[2] ?? 'config.yaml');
  const router = createRouter(cfg);
  const stop = new AbortController();

  const server = createServer(async (req, res) => {
    // Plain split, not new URL(): an invalid request-target must not throw outside the try below.
    const path = (req.url ?? '/').split('?')[0].split('/').filter(Boolean);
    let status = 200;
    let text = 'ok';
    try {
      if (req.method === 'POST') {
        if ((await router.deliver(await handle(cfg, req, path))) === 'retry') [status, text] = [503, 'delivery failed, please retry'];
      } else if (!(req.method === 'GET' && path.join('/') === 'health_check')) throw httpError(404, 'not found'); // not 405: keeps bot probes (GET /, /favicon.ico) out of the warn log
    } catch (err) {
      if (err instanceof HttpError) {
        [status, text] = [err.status, err.message];
        if (status !== 404) log('warn', 'request rejected', { path: path[0], status, reason: text });
      } else {
        [status, text] = [500, 'internal error'];
        log('error', 'request failed', { path: path[0], err: String(err) });
      }
    }
    // 413 leaves the rest of the body unread on the socket: close it so the next request on it isn't garbage.
    res.writeHead(status, { 'content-type': 'text/plain', ...(status === 413 && { connection: 'close' }) }).end(text);
  });
  // Defaults are 300 s / 60 s; these only cover receiving the request, not our delivery time.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(cfg.port, () => log('info', 'listening', { port: cfg.port, apps: [...cfg.apps.keys()], targets: [...cfg.targets.keys()] }));

  startPlayPoller(cfg, router, await loadStateStore(cfg.stateStore), stop.signal);

  // Finish in-flight deliveries on deploys. Node as PID 1 ignores SIGTERM unless handled.
  const shutdown = () => {
    log('info', 'shutting down');
    stop.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

await main();
