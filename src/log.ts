export const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

// fetch throws a bare "fetch failed" and puts the reason (ENOTFOUND, ECONNREFUSED, a TLS error) in cause.
export const errText = (err: unknown) => {
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  return cause ? `${err}: ${cause}` : String(err);
};
