const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const util = require("node:util");
const { resolveFfmpegPath } = require("./export");

const execFileAsync = util.promisify(execFile);

const getPlaybackPreviewPath = (recordingPath) => {
  const parsed = path.parse(recordingPath);
  return path.join(parsed.dir, ".meetlify", "derived", `${parsed.name}.preview.wav`);
};

const ensurePlaybackPreview = async (recordingPath) => {
  const previewPath = getPlaybackPreviewPath(recordingPath);
  await fs.mkdir(path.dirname(previewPath), { recursive: true });
  const [sourceStats, previewStats] = await Promise.all([
    fs.stat(recordingPath),
    fs.stat(previewPath).catch(() => null),
  ]);

  if (!sourceStats || sourceStats.size <= 42) {
    throw new Error("Recording file is empty or invalid. Please record again.");
  }

  const previewIsFresh = previewStats && previewStats.mtimeMs >= sourceStats.mtimeMs;
  if (!previewIsFresh) {
    try {
      await execFileAsync("afconvert", [
        "-f",
        "WAVE",
        "-d",
        "LEI16@48000",
        recordingPath,
        previewPath,
      ]);
    } catch {
      try {
        const ffmpegPath = resolveFfmpegPath();
        await execFileAsync(ffmpegPath, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          recordingPath,
          "-vn",
          "-ac",
          "2",
          "-ar",
          "48000",
          previewPath,
        ]);
      } catch {
        throw new Error("Could not decode this recording for in-app playback.");
      }
    }
  }

  return previewPath;
};

module.exports = {
  ensurePlaybackPreview,
};
