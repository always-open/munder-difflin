/**
 * Session-scoped tunnelmole cache — one tunnel client per local port.
 *
 * tunnelmole (2.x) exposes no close handle: every call opens a NEW persistent
 * websocket + public-URL registration that lives until process exit. The
 * Slack/webhook servers used to call it once per start(), so each Settings
 * toggle/restart leaked an extra live client AND another public URL that still
 * forwarded into the current listener. Caching the (promise of the) tunnel per
 * port bounds that to one client per port per app run, and repeat starts reuse
 * the same public URL — which Slack keeps anyway.
 *
 * The wait is capped per-call but the OPEN is never abandoned: a tunnel that
 * comes up after the caller timed out stays cached and is handed out instantly
 * on the next start, instead of becoming an untracked live entry point.
 */

const tunnels = new Map<number, Promise<string>>();

export function getTunnel(port: number, timeoutMs: number): Promise<string> {
  let p = tunnels.get(port);
  if (!p) {
    p = (async () => {
      // Dynamic import keeps the ESM-only `tunnelmole` out of the CJS require graph.
      const { tunnelmole } = await import('tunnelmole');
      const url = await tunnelmole({ port });
      if (!url) throw new Error('tunnelmole returned empty URL');
      return url;
    })();
    // A failed open must not poison the cache — let the next start() retry.
    p.catch(() => { if (tunnels.get(port) === p) tunnels.delete(port); });
    tunnels.set(port, p);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    p.then(
      (url) => { clearTimeout(timer); resolve(url); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
