const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

let electronApp = null;
try {
  const electron = require("electron");
  electronApp = electron?.app ?? null;
} catch {
  electronApp = null;
}

const getCandidateEnvPaths = () => {
  const candidates = new Set();

  candidates.add(path.join(process.cwd(), ".env"));
  if (electronApp?.getAppPath) {
    candidates.add(path.join(electronApp.getAppPath(), ".env"));
  }
  if (electronApp?.getPath) {
    candidates.add(path.join(electronApp.getPath("userData"), ".env"));
  }
  candidates.add(path.join(__dirname, "..", "..", "..", ".env"));

  return Array.from(candidates);
};

const loadEnv = () => {
  const candidates = getCandidateEnvPaths();

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    dotenv.config({ path: envPath, quiet: true });
    process.env.GEMINI_ENV_PATH = envPath;
    return envPath;
  }

  dotenv.config({ quiet: true });
  return null;
};

module.exports = {
  loadEnv,
  getCandidateEnvPaths,
};
