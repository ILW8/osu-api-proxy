import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseConnectRequest } from "../src/parse-connect.js";

describe("parseConnectRequest", () => {
  it("parses a valid CONNECT request", () => {
    const data = Buffer.from(
      "CONNECT osu.ppy.sh:443 HTTP/1.1\r\nHost: osu.ppy.sh:443\r\n\r\n"
    );
    const req = parseConnectRequest(data);
    assert.ok(req);
    assert.equal(req.method, "CONNECT");
    assert.equal(req.host, "osu.ppy.sh");
    assert.equal(req.port, 443);
    assert.equal(req.destination, "osu.ppy.sh:443");
  });

  it("returns null when header terminator is missing", () => {
    const data = Buffer.from("CONNECT osu.ppy.sh:443 HTTP/1.1\r\nHost: osu");
    assert.equal(parseConnectRequest(data), null);
  });

  it("returns null for malformed request line", () => {
    const data = Buffer.from("GET / HTTP/1.1\r\n\r\n");
    assert.equal(parseConnectRequest(data), null);
  });

  it("parses HTTP/1.0 requests", () => {
    const data = Buffer.from("CONNECT example.com:8080 HTTP/1.0\r\n\r\n");
    const req = parseConnectRequest(data);
    assert.ok(req);
    assert.equal(req.host, "example.com");
    assert.equal(req.port, 8080);
  });

  it("reports correct headerEndIndex", () => {
    const raw = "CONNECT osu.ppy.sh:443 HTTP/1.1\r\n\r\n";
    const data = Buffer.from(raw);
    const req = parseConnectRequest(data);
    assert.ok(req);
    assert.equal(req.headerEndIndex, raw.length);
  });
});
