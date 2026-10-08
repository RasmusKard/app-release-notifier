import type { Config, Route } from './config.ts';
import { log } from './log.ts';
import type { Message, Severity } from './message.ts';
import { statusOf, type Delivery } from './targets/shared.ts';

const RANK: Record<Severity, number> = { info: 0, success: 1, warning: 2, error: 3 };
const matchType = (pattern: string, type: string) =>
  pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;

/** Every matching route fires. A target hit by several routes gets one delivery: mention if any route asks, silent only if all do. */
export function plan(m: Message, routes: Route[]): Map<string, Delivery> {
  const out = new Map<string, Delivery>();
  for (const r of routes) {
    if (!r.types.some((p) => matchType(p, m.type))) continue;
    if (RANK[m.severity] < RANK[r.minSeverity]) continue;
    if (!Object.entries(r.labels).every(([k, v]) => m.labels[k] === v)) continue;
    for (const id of r.targets) {
      const prev = out.get(id);
      out.set(id, prev ? { mention: prev.mention || r.mention, silent: prev.silent && r.silent } : { mention: r.mention, silent: r.silent });
    }
  }
  return out;
}

export type Outcome = 'ok' | 'retry';

export function createRouter(cfg: Pick<Config, 'routes' | 'targets'>) {
  /**
   * 'retry' only when no target got the message and at least one failed transiently. If any target got it, a resend
   * would duplicate it there, so failures are logged at error level instead (alert on those in your log tooling).
   */
  async function deliverOne(input: Message): Promise<Outcome> {
    const t = Date.parse(input.time ?? '');
    const m = { ...input, time: new Date(Number.isNaN(t) ? Date.now() : t).toISOString() };
    const results = await Promise.all(
      [...plan(m, cfg.routes)].map(async ([id, d]) => {
        const { target, cfg: tcfg } = cfg.targets.get(id)!;
        const ctx = { msgId: m.id, type: m.type, target: id };
        let payload: unknown;
        try {
          payload = target.render(m, tcfg, d);
        } catch (err) {
          log('error', 'render failed', { ...ctx, err: String(err) });
          return 'failed' as const; // a resend can't fix a render bug
        }
        try {
          await target.send(payload, tcfg);
          log('info', 'delivered', ctx);
          return 'delivered' as const;
        } catch (err) {
          const status = statusOf(err);
          const transient = status === undefined || status === 429 || status >= 500;
          return { ctx: { ...ctx, status, err: String(err) }, transient };
        }
      }),
    );
    const anyDelivered = results.includes('delivered');
    let outcome: Outcome = 'ok';
    for (const r of results) {
      if (typeof r === 'string') continue;
      if (r.transient && !anyDelivered) {
        log('warn', 'delivery failed, asking the sender to retry', r.ctx);
        outcome = 'retry';
      } else
        log('error', r.transient ? 'delivery failed, not retried because another target got it' : 'delivery rejected', r.ctx);
    }
    return outcome;
  }

  /** Deliver to every routed target. 'retry' means some message reached no target: reply 5xx so the sender resends. */
  async function deliver(msgs: Message[]): Promise<Outcome> {
    return (await Promise.all(msgs.map(deliverOne))).includes('retry') ? 'retry' : 'ok';
  }

  return { deliver };
}

export type Router = ReturnType<typeof createRouter>;
