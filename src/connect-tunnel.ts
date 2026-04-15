import { connect } from "cloudflare:sockets";
import { computeHmac } from "./hmac.js";

/** Headers that must not be forwarded through the tunnel. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export interface TunnelConfig {
  proxyHost: string;
  proxyPort: number;
  proxyUser: string;
  proxySecret: string;
}

/**
 * Send an HTTP request to osu.ppy.sh through a CONNECT tunnel.
 *
 * Flow: TCP connect → CONNECT + HMAC → startTls → raw HTTP/1.1
 */
export async function fetchViaTunnel(
  config: TunnelConfig,
  method: string,
  path: string,
  search: string,
  headers: Headers,
  body: ArrayBuffer | null,
): Promise<Response> {
  const encoder = new TextEncoder();

  // 1. TCP connect to entry proxy
  const socket = connect(
    { hostname: config.proxyHost, port: config.proxyPort },
    { secureTransport: "off", allowHalfOpen: false },
  );

  // 2. Compute HMAC auth
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const mac = await computeHmac(
    config.proxySecret,
    `${timestamp}:${nonce}`,
  );

  // 3. Send CONNECT request
  const connectReq =
    `CONNECT osu.ppy.sh:443 HTTP/1.1\r\n` +
    `Host: osu.ppy.sh:443\r\n` +
    `Proxy-Authorization: HMAC ${config.proxyUser}:${timestamp}:${nonce}:${mac}\r\n` +
    `\r\n`;

  const writer = socket.writable.getWriter();
  await writer.write(encoder.encode(connectReq));
  writer.releaseLock();

  // 4. Read CONNECT response
  const connectResp = await readUntilDoubleCRLF(socket.readable);
  const statusLine = connectResp.split("\r\n")[0];

  if (!statusLine.startsWith("HTTP/1.1 200") && !statusLine.startsWith("HTTP/1.0 200")) {
    await socket.close().catch(() => {});
    const statusMatch = statusLine.match(/\s(\d{3})\s/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 502;
    return new Response(`CONNECT proxy error: ${statusLine}`, { status });
  }

  // 5. Upgrade to end-to-end TLS through the tunnel
  const tls = socket.startTls({ expectedServerHostname: "osu.ppy.sh" });

  // 6. Build and send raw HTTP/1.1 request
  let reqStr = `${method} ${path}${search} HTTP/1.1\r\n`;
  reqStr += `Host: osu.ppy.sh\r\n`;
  reqStr += `Connection: close\r\n`;

  for (const [key, value] of headers) {
    reqStr += `${key}: ${value}\r\n`;
  }

  if (body && body.byteLength > 0) {
    reqStr += `Content-Length: ${body.byteLength}\r\n`;
  }
  reqStr += `\r\n`;

  const tlsWriter = tls.writable.getWriter();
  await tlsWriter.write(encoder.encode(reqStr));
  if (body && body.byteLength > 0) {
    await tlsWriter.write(new Uint8Array(body));
  }
  tlsWriter.releaseLock();

  // 7. Parse raw HTTP/1.1 response
  return readHttpResponse(tls.readable);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read from a stream until the header terminator `\r\n\r\n` is found.
 * Returns the complete buffer including the terminator as a string.
 *
 * Assumption: the proxy will not send any bytes after the CONNECT 200 response
 * until the client initiates (which is the TLS ClientHello after startTls).
 */
async function readUntilDoubleCRLF(
  readable: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Connection closed before CONNECT response");
      buf += decoder.decode(value, { stream: true });
      if (buf.length > 8192) throw new Error("CONNECT response too large");
      if (buf.includes("\r\n\r\n")) return buf;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a raw HTTP/1.1 response from a ReadableStream.
 *
 * Returns a standard Response whose body is a ReadableStream that yields
 * the remaining bytes after the response headers. Hop-by-hop headers are
 * stripped so the Cloudflare runtime can re-frame the body for the caller.
 */
async function readHttpResponse(
  readable: ReadableStream<Uint8Array>,
): Promise<Response> {
  const reader = readable.getReader();
  let headerBuf = new Uint8Array(0);

  // Read until we find \r\n\r\n
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Connection closed before response headers");

    const next = new Uint8Array(headerBuf.length + value.length);
    next.set(headerBuf);
    next.set(value, headerBuf.length);
    headerBuf = next;

    if (headerBuf.length > 65536) throw new Error("Response headers too large");
    if (findDoubleCRLF(headerBuf) !== -1) break;
  }

  const boundary = findDoubleCRLF(headerBuf);
  const headerStr = new TextDecoder().decode(headerBuf.subarray(0, boundary));
  const bodyPrefix = headerBuf.subarray(boundary + 4);

  // Parse status line
  const lines = headerStr.split("\r\n");
  const statusMatch = lines[0].match(/^HTTP\/1\.[01]\s+(\d+)\s*(.*)/);
  if (!statusMatch) throw new Error(`Invalid status line: ${lines[0]}`);
  const status = parseInt(statusMatch[1], 10);
  const statusText = statusMatch[2] || "";

  // Parse headers
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      const key = lines[i].substring(0, colon).trim();
      const val = lines[i].substring(colon + 1).trim();
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        headers.append(key, val);
      }
    }
  }

  // Body stream: emit leftover bytes first, then continue reading
  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bodyPrefix.length > 0) {
        controller.enqueue(bodyPrefix);
      }
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(bodyStream, { status, statusText, headers });
}

function findDoubleCRLF(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}
