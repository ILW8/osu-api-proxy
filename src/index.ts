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
 *
 * When CONNECT_PROXY_HOST is set, requests are tunneled through a CONNECT
 * proxy so the proxy infrastructure only sees ciphertext (end-to-end TLS).
 */

import { DurableObject } from "cloudflare:workers";
import { fetchViaTunnel, type TunnelConfig } from "./connect-tunnel.js";

export interface Env {
  PROXY_SECRET?: string;
  RATE_LIMITER: DurableObjectNamespace<UpstreamRateLimiter>;
  /** Entry proxy hostname or IP. Enables CONNECT tunnel mode when set. */
  CONNECT_PROXY_HOST?: string;
  /** Entry proxy port (default: "8080"). */
  CONNECT_PROXY_PORT?: string;
  /** User ID for HMAC authentication with the proxy. */
  CONNECT_PROXY_USER?: string;
  /** Shared secret (hex) for HMAC authentication with the proxy. */
  CONNECT_PROXY_SECRET?: string;
}

const DEFAULT_OSU_ORIGIN = "https://osu.ppy.sh";

const ALLOWED_PREFIXES = ["/api/v2/", "/api/v2", "/oauth/token", "/api", "/api/"];

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

    // Build sanitized headers
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
        headers.set(key, value);
      }
    }

    // acquire a rate-limit slot from the durable object
    const id = env.RATE_LIMITER.idFromName("global");
    const stub = env.RATE_LIMITER.get(id);
    const slot = await stub.fetch(new Request("https://rate-limiter.internal/acquire"));
    if (!slot.ok) {
      return slot;
    }

    // Branch: CONNECT tunnel or direct fetch
    try {
      if (env.CONNECT_PROXY_HOST && env.CONNECT_PROXY_USER && env.CONNECT_PROXY_SECRET) {
        const tunnelConfig: TunnelConfig = {
          proxyHost: env.CONNECT_PROXY_HOST,
          proxyPort: parseInt(env.CONNECT_PROXY_PORT || "8080", 10),
          proxyUser: env.CONNECT_PROXY_USER,
          proxySecret: env.CONNECT_PROXY_SECRET,
        };

        const body = !["GET", "HEAD"].includes(request.method)
          ? await request.arrayBuffer()
          : null;

        return await fetchViaTunnel(
          tunnelConfig,
          request.method,
          path,
          url.search,
          headers,
          body,
        );
      }

      // Direct fetch (original behavior)
      const target = `${DEFAULT_OSU_ORIGIN}${path}${url.search}`;
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "follow",
      };

      if (!["GET", "HEAD"].includes(request.method)) {
        init.body = request.body;
      }

      const upstream = await fetch(target, init);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(502, { error: "Failed to reach osu.ppy.sh", detail: msg });
    }
  },
};


// durable object impl.
interface QueueEntry {
  resolve: (response: Response) => void;
  enqueuedAt: number;
}

export class UpstreamRateLimiter extends DurableObject<Env> {
  private timestamps: number[] = [];
  private queue: QueueEntry[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  override async fetch(_request: Request): Promise<Response> {
    this.pruneTimestamps();
    if (this.timestamps.length < RATE_LIMIT) {
      return this.grantSlot();
    }

    // slow path (queue and wait for a slot)
    return new Promise<Response>((resolve) => {
      const entry: QueueEntry = { resolve, enqueuedAt: Date.now() };
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

  private grantSlot(): Response {
    this.timestamps.push(Date.now());
    return json(200, { status: "ok" });
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
      entry.resolve(this.grantSlot());
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
