#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const candidates = [
  { command: "docker", baseArgs: ["compose"] },
  { command: "docker-compose", baseArgs: [] },
];

for (const candidate of candidates) {
  const probe = spawnSync(candidate.command, [...candidate.baseArgs, "version"], {
    stdio: "ignore",
  });

  if (probe.status !== 0) {
    continue;
  }

  const result = spawnSync(candidate.command, [...candidate.baseArgs, ...args], {
    stdio: "inherit",
  });

  process.exit(result.status ?? 1);
}

console.error("Docker Compose is required. Install either `docker compose` or `docker-compose`.");
process.exit(1);
