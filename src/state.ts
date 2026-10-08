import { pathToFileURL } from 'node:url';

/** Values are JSON strings. */
export interface StateStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

function memoryStore(): StateStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) };
}

type Fns = { get: (key: string) => unknown; set: (key: string, value: string) => unknown };
const isStore = (v: unknown): v is Fns => !!v && typeof v === 'object' && typeof (v as Fns).get === 'function' && typeof (v as Fns).set === 'function';
export async function loadStateStore(path: string | undefined): Promise<StateStore> {
  if (!path) return memoryStore();
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (err) {
    throw new Error(`config: could not load stateStore ${path}: ${(err as Error).message}`);
  }
  const s = isStore(mod) ? mod : (mod as { default?: unknown }).default;
  if (!isStore(s)) throw new Error(`config: stateStore ${path} must export get(key) and set(key, value)`);
  // async: a store whose get/set throws or returns synchronously must become a rejection, not an unhandled crash in the poller
  return { get: async (k) => (await s.get(k)) as string | undefined, set: async (k, v) => { await s.set(k, v); } };
}
