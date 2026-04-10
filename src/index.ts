/**
 * osu! API v2 Proxy Cloudflare Worker
 *
 * Proxies requests to osu.ppy.sh so that callers (e.g. Google Apps Script)
 * are no longer subject to Cloudflare's per-IP rate limit on Google's
 * shared egress pool.
 */

export interface Env {
  /**
   * Optional authentication:
   * Set the PROXY_SECRET secret in wrangler and pass it via the
   * X-Proxy-Secret header. When unset, the proxy is open.
   */
  PROXY_SECRET?: string;
}

const OSU_ORIGIN = "https://osu.ppy.sh";

const ALLOWED_PREFIXES = ["/api/v2/", "/api/v2", "/oauth/token"];

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

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "follow",
    };

    if (!["GET", "HEAD"].includes(request.method)) {
      init.body = request.body;
    }

    // --- Proxy ----------------------------------------------------------
    try {
      const upstream = await fetch(target, init);

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (err: any) {
      return json(502, { error: "Failed to reach osu.ppy.sh", detail: err.message });
    }
  },
};

function json(status: number, body: any): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

