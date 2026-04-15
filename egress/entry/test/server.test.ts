import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as http from "node:http";
import { createEntryProxy } from "../src/server.js";
import { computeHmac } from "../src/hmac.js";

const SECRET = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const USERS = { alice: SECRET };

function makeConnectRequest(
  destination: string,
  secret: string,
): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = "test-nonce-" + Math.random().toString(36).slice(2);
  const digest = computeHmac(secret, `${ts}:${nonce}`);
  return (
    `CONNECT ${destination} HTTP/1.1\r\n` +
    `Host: ${destination}\r\n` +
    `Proxy-Authorization: HMAC ${ts}:${nonce}:${digest}\r\n\r\n`
  );
}

describe("Entry proxy server", () => {
  let mockWorker: net.Server;
  let mockWorkerPort: number;
  let proxy: ReturnType<typeof createEntryProxy>;
  let proxyPort: number;

  before(async () => {
    // Mock worker: accepts CONNECT, sends 200, echoes data
    mockWorker = net.createServer((client) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.indexOf("\r\n\r\n") !== -1) {
          client.removeListener("data", onData);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          client.on("data", (d) => client.write(d)); // echo
        }
      };
      client.on("data", onData);
    });
    await new Promise<void>((r) => mockWorker.listen(0, r));
    mockWorkerPort = (mockWorker.address() as net.AddressInfo).port;

    proxy = createEntryProxy({
      port: 0,
      healthPort: 0,
      users: USERS,
      allowedDestinations: new Set(["osu.ppy.sh:443"]),
      workerHost: "127.0.0.1",
      workerPort: mockWorkerPort,
      rateLimitPerUser: 5,
      rateLimitWindowMs: 60_000,
    });
    await proxy.listen();
    proxyPort = (proxy.server.address() as net.AddressInfo).port;
  });

  after(async () => {
    await proxy.close();
    await new Promise<void>((r, j) => mockWorker.close((e) => (e ? j(e) : r())));
  });

  function connectToProxy(): net.Socket {
    return net.connect({ host: "127.0.0.1", port: proxyPort });
  }

  function readOnce(socket: net.Socket): Promise<Buffer> {
    return new Promise((resolve) => socket.once("data", resolve));
  }

  it("authenticates and establishes tunnel", async () => {
    const client = connectToProxy();
    await new Promise<void>((r) => client.on("connect", r));

    client.write(makeConnectRequest("osu.ppy.sh:443", SECRET));
    const resp = (await readOnce(client)).toString();
    assert.ok(resp.startsWith("HTTP/1.1 200"), `Expected 200, got: ${resp}`);

    // Tunnel should relay data (mock worker echoes)
    client.write("hello-through-tunnel");
    const echo = (await readOnce(client)).toString();
    assert.equal(echo, "hello-through-tunnel");

    client.destroy();
  });

  it("rejects missing auth with 401", async () => {
    const client = connectToProxy();
    await new Promise<void>((r) => client.on("connect", r));

    client.write("CONNECT osu.ppy.sh:443 HTTP/1.1\r\nHost: osu.ppy.sh:443\r\n\r\n");
    const resp = (await readOnce(client)).toString();
    assert.ok(resp.startsWith("HTTP/1.1 401"), `Expected 401, got: ${resp}`);

    client.destroy();
  });

  it("rejects bad HMAC with 401", async () => {
    const client = connectToProxy();
    await new Promise<void>((r) => client.on("connect", r));

    const ts = Math.floor(Date.now() / 1000);
    const badAuth =
      `CONNECT osu.ppy.sh:443 HTTP/1.1\r\n` +
      `Proxy-Authorization: HMAC ${ts}:nonce:${"0".repeat(64)}\r\n\r\n`;
    client.write(badAuth);
    const resp = (await readOnce(client)).toString();
    assert.ok(resp.startsWith("HTTP/1.1 401"), `Expected 401, got: ${resp}`);

    client.destroy();
  });

  it("rejects non-allowed destination with 403", async () => {
    const client = connectToProxy();
    await new Promise<void>((r) => client.on("connect", r));

    client.write(makeConnectRequest("evil.com:443", "alice", SECRET));
    const resp = (await readOnce(client)).toString();
    assert.ok(resp.startsWith("HTTP/1.1 403"), `Expected 403, got: ${resp}`);

    client.destroy();
  });
});
