const { promisify } = require("util");
const { execFile } = require("child_process");
const { getRecorderBinaryPath } = require("./paths");

const execFileAsync = promisify(execFile);
const CHECK_PERMISSIONS_TIMEOUT_MS = 10_000;

const parseLastJsonLine = (value) => {
  const lines = String(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning backwards for the last valid JSON line.
    }
  }

  return null;
};

module.exports.checkPermissions = async () => {
  const recorderBinaryPath = getRecorderBinaryPath();

  try {
    const { stdout, stderr } = await execFileAsync(recorderBinaryPath, ["--check-permissions"], {
      timeout: CHECK_PERMISSIONS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    const payload = parseLastJsonLine(stdout);

    if (!payload || typeof payload.code !== "string") {
      throw new Error(`Unexpected permission response. stdout="${String(stdout).trim()}" stderr="${String(stderr).trim()}"`);
    }

    return payload.code === "PERMISSION_GRANTED";
  } catch (error) {
    const baseMessage = error?.message ? String(error.message) : "Unknown permission-check error";
    throw new Error(`Failed to check recorder permissions: ${baseMessage}`);
  }
};
