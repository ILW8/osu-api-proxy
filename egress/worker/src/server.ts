import * as net from "node:net";
import * as http from "node:http";
import { parseConnectRequest } from "./parse-connect.js";
import { SlidingWindowCounter } from "./rate-limit.js";

export interface WorkerConfig {
  port: number;
  healthPort: number;
  allowedDestinations: Set<string>;
  rateLimit: number;
  rateLimitWindowMs: number;
}

export function createWorkerProxy(config: WorkerConfig) {
  const rateLimiter = new SlidingWindowCounter(
    config.rateLimit,
    config.rateLimitWindowMs,
  );

  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.length > 4096) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }

      const req = parseConnectRequest(buffer);
      if (!req) {
        // If headers are complete but still failed to parse, reject with 400
        if (buffer.indexOf("\r\n\r\n") !== -1) {
          client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        }
        // Otherwise keep buffering — headers not yet complete
        return;
      }

      client.removeListener("data", onData);

      if (req.method !== "CONNECT") {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }

      if (!config.allowedDestinations.has(req.destination)) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }

      if (!rateLimiter.tryAcquire()) {
        client.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        return;
      }

      const upstream = net.connect(
        { host: req.host, port: req.port },
        () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          client.pipe(upstream);
          upstream.pipe(client);
        },
      );

      upstream.on("error", () => {
        if (!client.destroyed) client.destroy();
      });
      client.on("error", () => {
        if (!upstream.destroyed) upstream.destroy();
      });
      upstream.on("close", () => {
        if (!client.destroyed) client.destroy();
      });
      client.on("close", () => {
        if (!upstream.destroyed) upstream.destroy();
      });
    };

    client.on("data", onData);
    client.on("error", () => {}); // prevent unhandled
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
