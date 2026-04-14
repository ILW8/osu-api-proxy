export interface ConnectRequest {
  method: string;
  host: string;
  port: number;
  destination: string;
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

  return {
    method,
    host,
    port,
    destination: `${host}:${port}`,
    headerEndIndex: headerEnd + 4,
  };
}
