/**
 * osu! API v2 Proxy Cloudflare Worker
 *
 * Proxies requests to osu.ppy.sh so that callers (e.g. Google Apps Script)
 * are no longer subject to Cloudflare's per-IP rate limit on Google's
 * shared egress pool.
 *
 * Upstream requests are rate-limited to 5 requests per 5 seconds (avg 1 req/s
 * with a max burst of 5 requests). Excess requests are queued and will time
 * out with 504 if they wait too long.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  PROXY_SECRET?: string;
  RATE_LIMITER: DurableObjectNamespace<UpstreamRateLimiter>;
}

const OSU_ORIGIN = "https://osu.ppy.sh";

const ALLOWED_PREFIXES = ["/api/v2/", "/api/v2", "/oauth/token"];

const RATE_LIMIT = 5;
const WINDOW_MS = 5_000;
const QUEUE_TIMEOUT_MS = 60_000;

/** Headers that should never be forwarded to the origin. */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "x-proxy-secret",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
  "cf-worker",
  "cdn-loop",
]);

// noinspection JSUnusedGlobalSymbols
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // allows uptime checker
    if (path === "/" || path === "/health") {
      return json(200, {
        status: "ok",
        proxy: "osu-api-proxy",
        usage: "Replace https://osu.ppy.sh with this worker's URL in your requests.",
      });
    }

    if (!ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(p + (p.endsWith("/") ? "" : "/")))) {
      return json(404, {
        error: "This proxy only forwards /api/v2/* and /oauth/token.",
      });
    }

    // rudimentary way to authenticate requests
    if (env.PROXY_SECRET) {
      const provided = request.headers.get("X-Proxy-Secret") || url.searchParams.get("proxy_secret");
      if (provided !== env.PROXY_SECRET) {
        return json(401, { error: "Invalid or missing X-Proxy-Secret header." });
      }
    }

    url.searchParams.delete("proxy_secret");
    const target = `${OSU_ORIGIN}${path}${url.search}`;

    const headers = new Headers();
    for (const [key, value] of request.headers) {
      if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
        headers.set(key, value);
      }
    }

    headers.set("X-Upstream-Target", target);

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "follow",
    };

    if (!["GET", "HEAD"].includes(request.method)) {
      init.body = request.body;
    }

    // queue request through durable object
    const id = env.RATE_LIMITER.idFromName("global");
    const stub = env.RATE_LIMITER.get(id);
    return stub.fetch(new Request("https://rate-limiter.internal/proxy", init));
  },
};


// durable object impl.
interface QueueEntry {
  target: string;
  init: RequestInit;
  resolve: (response: Response) => void;
  enqueuedAt: number;
}

export class UpstreamRateLimiter extends DurableObject<Env> {
  private timestamps: number[] = [];
  private queue: QueueEntry[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  override async fetch(request: Request): Promise<Response> {
    const target = request.headers.get("X-Upstream-Target");
    if (!target) return json(400, { error: "Missing X-Upstream-Target" });

    const headers = new Headers(request.headers);
    headers.delete("X-Upstream-Target");

    const init: RequestInit = { method: request.method, headers, redirect: "follow" };

    // need to buffer body, streams can only be read once and request may be queued
    if (!["GET", "HEAD"].includes(request.method)) {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 0) init.body = buf;
    }

    this.pruneTimestamps();
    if (this.timestamps.length < RATE_LIMIT) {
      return this.sendUpstream(target, init);
    }

    // slow path (queue and wait)
    return new Promise<Response>((resolve) => {
      const entry: QueueEntry = { target, init, resolve, enqueuedAt: Date.now() };
      this.queue.push(entry);

      setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          resolve(json(504, { error: "Request timed out waiting for upstream capacity" }));
        }
      }, QUEUE_TIMEOUT_MS);

      this.ensureDrainScheduled();
    });
  }

  private async sendUpstream(target: string, init: RequestInit): Promise<Response> {
    this.timestamps.push(Date.now());
    try {
      const upstream = await fetch(target, init);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(502, { error: "Failed to reach osu.ppy.sh", detail: msg });
    } finally {
      this.ensureDrainScheduled();
    }
  }

  private pruneTimestamps(): void {
    const cutoff = Date.now() - WINDOW_MS;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  private ensureDrainScheduled(): void {
    if (this.drainTimer !== null || this.queue.length === 0) return;
    this.pruneTimestamps();
    if (this.timestamps.length < RATE_LIMIT) {
      this.processQueue();
      return;
    }
    const waitMs = Math.max(10, this.timestamps[0] + WINDOW_MS - Date.now() + 10);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.processQueue();
    }, waitMs);
  }

  private processQueue(): void {
    this.pruneTimestamps();
    while (this.queue.length > 0 && this.timestamps.length < RATE_LIMIT) {
      const entry = this.queue.shift()!;
      this.sendUpstream(entry.target, entry.init).then(entry.resolve);
    }
    this.ensureDrainScheduled();
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

