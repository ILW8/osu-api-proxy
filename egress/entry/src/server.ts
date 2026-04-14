import * as net from "node:net";
import * as http from "node:http";
import { parseConnectRequest } from "./parse-connect.js";
import { validateAuth } from "./auth.js";
import { PerUserRateLimiter } from "./rate-limit.js";

export interface EntryConfig {
  port: number;
  healthPort: number;
  users: Record<string, string>;
  allowedDestinations: Set<string>;
  workerHost: string;
  workerPort: number;
  rateLimitPerUser: number;
  rateLimitWindowMs: number;
}

export function createEntryProxy(config: EntryConfig) {
  const rateLimiter = new PerUserRateLimiter(
    config.rateLimitPerUser,
    config.rateLimitWindowMs,
  );

  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.length > 8192) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }

      const req = parseConnectRequest(buffer);
      if (!req) return;

      client.removeListener("data", onData);

      if (req.method !== "CONNECT") {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }

      if (!config.allowedDestinations.has(req.destination)) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }

      // Authenticate
      const authHeader = req.headers.get("proxy-authorization");
      const authResult = validateAuth(authHeader, config.users);
      if (!authResult.valid) {
        client.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }

      // Rate limit
      if (!rateLimiter.tryAcquire(authResult.userId!)) {
        client.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        return;
      }

      // Forward CONNECT to worker
      const worker = net.connect(
        { host: config.workerHost, port: config.workerPort },
        () => {
          worker.write(
            `CONNECT ${req.destination} HTTP/1.1\r\nHost: ${req.destination}\r\n\r\n`,
          );
        },
      );

      let workerBuf = Buffer.alloc(0);
      const onWorkerData = (chunk: Buffer) => {
        workerBuf = Buffer.concat([workerBuf, chunk]);
        if (workerBuf.indexOf("\r\n\r\n") === -1) return;

        worker.removeListener("data", onWorkerData);
        const respStr = workerBuf.toString("utf8");

        if (!respStr.startsWith("HTTP/1.1 200")) {
          client.end(respStr.substring(0, respStr.indexOf("\r\n\r\n") + 4));
          worker.destroy();
          return;
        }

        // Tunnel established — relay to client and start piping
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

        // If there are bytes after the worker's header, forward them
        const headerEnd = workerBuf.indexOf("\r\n\r\n") + 4;
        if (headerEnd < workerBuf.length) {
          client.write(workerBuf.subarray(headerEnd));
        }

        client.pipe(worker);
        worker.pipe(client);
      };

      worker.on("data", onWorkerData);

      worker.on("error", () => {
        if (!client.destroyed) {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }
      });
      client.on("error", () => {
        if (!worker.destroyed) worker.destroy();
      });
      worker.on("close", () => {
        if (!client.destroyed) client.destroy();
      });
      client.on("close", () => {
        if (!worker.destroyed) worker.destroy();
      });
    };

    client.on("data", onData);
    client.on("error", () => {});
  });

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return {
    server,
    healthServer,
    listen() {
      return Promise.all([
        new Promise<void>((r) => server.listen(config.port, r)),
        new Promise<void>((r) => healthServer.listen(config.healthPort, r)),
      ]);
    },
    close() {
      return Promise.all([
        new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
        new Promise<void>((r, j) =>
          healthServer.close((e) => (e ? j(e) : r())),
        ),
      ]);
    },
  };
}
