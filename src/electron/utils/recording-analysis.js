const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const util = require("node:util");
const { resolveFfmpegPath } = require("./export");

const execFileAsync = util.promisify(execFile);

const resolveFfprobePath = () => {
  const ffmpegPath = resolveFfmpegPath();
  const siblingProbePath = path.join(path.dirname(ffmpegPath), "ffprobe");
  if (fsSync.existsSync(siblingProbePath)) {
    return siblingProbePath;
  }

  const candidates = [
    process.env.FFPROBE_PATH,
    process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, "bin", "ffprobe") : null,
    "/opt/homebrew/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "/usr/bin/ffprobe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("FFprobe is required to inspect recording duration.");
};

const parseDurationSeconds = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const getDurationWithFfprobe = async (filePath) => {
  const { stdout } = await execFileAsync(resolveFfprobePath(), [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });

  return parseDurationSeconds(String(stdout).trim());
};

const getDurationWithAfinfo = async (filePath) => {
  const { stdout } = await execFileAsync("/usr/bin/afinfo", [filePath], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });

  const match = String(stdout).match(/estimated duration:\s*([0-9.]+)\s*sec/i);
  return parseDurationSeconds(match?.[1]);
};

const getDurationSeconds = async (filePath) => {
  try {
    return await getDurationWithFfprobe(filePath);
  } catch {
    return getDurationWithAfinfo(filePath);
  }
};

const getRecordingAnalysis = async (filePath) => {
  const stats = await fs.stat(filePath);
  const durationSeconds = await getDurationSeconds(filePath);

  return {
    path: filePath,
    sizeBytes: stats.size,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
  };
};

module.exports = {
  getRecordingAnalysis,
};
