import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as http from "node:http";
import { createWorkerProxy } from "../src/server.js";

describe("Worker CONNECT proxy server", () => {
  let mockUpstream: net.Server;
  let mockUpstreamPort: number;
  let proxy: ReturnType<typeof createWorkerProxy>;
  let proxyPort: number;
  let healthPort: number;

  before(async () => {
    // Mock upstream: echoes all received data back
    mockUpstream = net.createServer((socket) => {
      socket.on("data", (data) => socket.write(data));
    });
    await new Promise<void>((r) => mockUpstream.listen(0, r));
    mockUpstreamPort = (mockUpstream.address() as net.AddressInfo).port;

    proxy = createWorkerProxy({
      port: 0,
      healthPort: 0,
      allowedDestinations: new Set([`127.0.0.1:${mockUpstreamPort}`]),
      // rateLimit is 6 (not 5) to account for the 1 token consumed by the
      // "establishes a tunnel" test which runs before the 429 test. The 429
      // test loop uses exactly 5 successful connections, so a total budget of
      // 6 ensures the 6th attempt (7th overall) is rate-limited as expected.
      rateLimit: 6,
      rateLimitWindowMs: 60_000,
    });
    await proxy.listen();
    proxyPort = (proxy.server.address() as net.AddressInfo).port;
    healthPort = (proxy.healthServer.address() as net.AddressInfo).port;
  });

  after(async () => {
    await proxy.close();
    await new Promise<void>((r, j) => mockUpstream.close((e) => (e ? j(e) : r())));
  });

  function connectToProxy(): net.Socket {
    return net.connect({ host: "127.0.0.1", port: proxyPort });
  }

  function readOnce(socket: net.Socket): Promise<Buffer> {
    return new Promise((resolve) => socket.once("data", resolve));
  }

  it("establishes a tunnel and relays data", async () => {
    const client = connectToProxy();
    await new Promise<void>((r) => client.on("connect", r));

    client.write(
      `CONNECT 127.0.0.1:${mockUpstreamPort} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${mockUpstreamPort}\r\n\r\n`,
    );

    const resp = (await readOnce(client)).toString();
    assert.ok(resp.startsWith("HTTP/1.1 200"), `Expected 200, got: ${resp}`);

    // Data should relay through the tunnel
    client.write("ping");
    const echo = (await readOnce(client)).toString();
    assert.equal(echo, "ping");

    client.destroy();
  });

  it("rejects non-allowed destinations with 403", async () => {
    const client = connectToProxy();
    await new Promise<void>((r) => client.on("connect", r));

    client.write("CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n");

    const resp = (await readOnce(client)).toString();
    assert.ok(resp.startsWith("HTTP/1.1 403"), `Expected 403, got: ${resp}`);

    client.destroy();
  });

  it("rejects non-CONNECT methods with 400", async () => {
    const client = connectToProxy();
    await new Promise<void>((r) => client.on("connect", r));

    client.write("GET / HTTP/1.1\r\n\r\n");

    const resp = (await readOnce(client)).toString();
    assert.ok(
      resp.startsWith("HTTP/1.1 400"),
      `Expected 400, got: ${resp}`,
    );

    client.destroy();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    // Exhaust the rate limit (5 requests)
    for (let i = 0; i < 5; i++) {
      const c = connectToProxy();
      await new Promise<void>((r) => c.on("connect", r));
      c.write(
        `CONNECT 127.0.0.1:${mockUpstreamPort} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${mockUpstreamPort}\r\n\r\n`,
      );
      const r = (await readOnce(c)).toString();
      assert.ok(r.startsWith("HTTP/1.1 200"), `Request ${i} should pass`);
      c.destroy();
    }

    // 6th request should be rate limited
    const client = connectToProxy();
    await new Promise<void>((r) => client.on("connect", r));
    client.write(
      `CONNECT 127.0.0.1:${mockUpstreamPort} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${mockUpstreamPort}\r\n\r\n`,
    );
    const resp = (await readOnce(client)).toString();
    assert.ok(resp.startsWith("HTTP/1.1 429"), `Expected 429, got: ${resp}`);

    client.destroy();
  });

  it("health endpoint returns 200", async () => {
    const resp = await new Promise<http.IncomingMessage>((resolve) => {
      http.get(`http://127.0.0.1:${healthPort}/health`, resolve);
    });
    assert.equal(resp.statusCode, 200);
  });
});
