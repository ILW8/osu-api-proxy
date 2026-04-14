import { readFileSync } from "node:fs";
import { createEntryProxy } from "./server.js";

const usersPath = process.env.USERS_PATH || "/run/secrets/users_json";
const users: Record<string, string> = JSON.parse(
  readFileSync(usersPath, "utf8"),
);

const config = {
  port: parseInt(process.env.PORT || "8080", 10),
  healthPort: parseInt(process.env.HEALTH_PORT || "8404", 10),
  users,
  allowedDestinations: new Set(
    (process.env.ALLOWED_DESTINATIONS || "osu.ppy.sh:443").split(","),
  ),
  workerHost: process.env.WORKER_HOST || "worker",
  workerPort: parseInt(process.env.WORKER_PORT || "8081", 10),
  rateLimitPerUser: parseInt(process.env.RATE_LIMIT_PER_USER || "60", 10),
  rateLimitWindowMs: parseInt(
    process.env.RATE_LIMIT_WINDOW_MS || "60000",
    10,
  ),
};

const proxy = createEntryProxy(config);
await proxy.listen();

console.log(`Entry proxy listening on :${config.port}`);
console.log(`Health check on :${config.healthPort}`);
console.log(`Loaded ${Object.keys(users).length} user(s)`);
