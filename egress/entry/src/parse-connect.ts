export interface ConnectRequest {
  method: string;
  host: string;
  port: number;
  destination: string;
  headers: Map<string, string>;
  headerEndIndex: number;
}

export function parseConnectRequest(data: Buffer): ConnectRequest | null {
  const headerEnd = data.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerStr = data.subarray(0, headerEnd).toString("utf8");
  const lines = headerStr.split("\r\n");

  const match = lines[0]?.match(/^(\w+)\s+(\S+):(\d+)\s+HTTP\/1\.[01]$/);
  if (!match) return null;

  const [, method, host, portStr] = match;
  const port = parseInt(portStr, 10);

  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      headers.set(
        lines[i].substring(0, colon).trim().toLowerCase(),
        lines[i].substring(colon + 1).trim(),
      );
    }
  }

  return {
    method,
    host,
    port,
    destination: `${host}:${port}`,
    headers,
    headerEndIndex: headerEnd + 4,
  };
}
