const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");
const { getAppStoragePaths } = require("./paths");

let activeSessionId = null;
let activeSessionLogPath = null;
let sessionHeaderWritten = false;
const listeners = new Set();

const getSessionsDir = () => {
  const { rootPath } = getAppStoragePaths();
  const sessionsPath = path.join(rootPath, "Logs", "sessions");
  if (!fs.existsSync(sessionsPath)) {
    fs.mkdirSync(sessionsPath, { recursive: true });
  }
  return sessionsPath;
};

const ensureSessionLog = () => {
  if (activeSessionLogPath) {
    return activeSessionLogPath;
  }

  const sessionToken = crypto.randomBytes(4).toString("hex");
  activeSessionId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}-${sessionToken}`;
  activeSessionLogPath = path.join(getSessionsDir(), `${activeSessionId}.log`);
  return activeSessionLogPath;
};

const writeSessionHeader = () => {
  if (sessionHeaderWritten) {
    return;
  }

  const logPath = ensureSessionLog();
  const header = {
    sessionId: activeSessionId,
    startedAt: new Date().toISOString(),
    appVersion: app?.getVersion?.() || "unknown",
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };

  fs.appendFileSync(logPath, `# Meetlify Session ${JSON.stringify(header)}\n`, "utf8");
  sessionHeaderWritten = true;
};

const getInternalLogPath = () => {
  writeSessionHeader();
  return activeSessionLogPath;
};

const buildEntry = (scope, message, extra = null) => {
  writeSessionHeader();
  const timestamp = new Date().toISOString();
  const payload = {
    sessionId: activeSessionId,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
  return {
    timestamp,
    scope,
    message,
    payload,
    line: `[${timestamp}] [${scope}] ${message}${extra == null ? ` ${JSON.stringify({ sessionId: activeSessionId })}` : ` ${JSON.stringify(payload)}`}`,
  };
};

const appendInternalLog = (scope, message, extra = null) => {
  try {
    const logPath = getInternalLogPath();
    const entry = buildEntry(scope, message, extra);
    fs.appendFileSync(logPath, `${entry.line}\n`, "utf8");
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // Listener failures must not break logging.
      }
    }
  } catch {
    // Logging must never break app behavior.
  }
};

const subscribeInternalLog = (listener) => {
  if (typeof listener !== "function") {
    return () => {};
  }

  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const parseLogLine = (line) => {
  const match = String(line || "").match(/^\[([^\]]+)\] \[([^\]]+)\] (.*?)(?: (\{.*\}))?$/u);
  if (!match) {
    return null;
  }

  const [, timestamp, scope, message, rawPayload] = match;
  let payload = {};
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = {};
    }
  }

  return {
    timestamp,
    scope,
    message,
    payload,
    line,
  };
};

const getRecentInternalLogs = (limit = 200) => {
  try {
    const logPath = getInternalLogPath();
    if (!fs.existsSync(logPath)) {
      return [];
    }

    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw
      .split(/\r?\n/gu)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((line) => !line.startsWith("# Meetlify Session "))
      .slice(-Math.max(1, Number(limit) || 200));

    return lines.map(parseLogLine).filter(Boolean);
  } catch {
    return [];
  }
};

module.exports = {
  appendInternalLog,
  getInternalLogPath,
  getRecentInternalLogs,
  subscribeInternalLog,
};
