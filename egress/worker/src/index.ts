import { createWorkerProxy } from "./server.js";

const config = {
  port: parseInt(process.env.PORT || "8081", 10),
  healthPort: parseInt(process.env.HEALTH_PORT || "8404", 10),
  allowedDestinations: new Set(
    (process.env.ALLOWED_DESTINATIONS || "osu.ppy.sh:443").split(","),
  ),
  rateLimit: parseInt(process.env.RATE_LIMIT || "120", 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
};

const proxy = createWorkerProxy(config);
await proxy.listen();

console.log(`Worker CONNECT proxy listening on :${config.port}`);
console.log(`Health check on :${config.healthPort}`);
