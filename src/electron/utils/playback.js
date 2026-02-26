const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const util = require("node:util");

const execFileAsync = util.promisify(execFile);

const getPlaybackPreviewPath = (recordingPath) => {
  const parsed = path.parse(recordingPath);
  return path.join(parsed.dir, `.${parsed.name}.preview.wav`);
};

const ensurePlaybackPreview = async (recordingPath) => {
  const previewPath = getPlaybackPreviewPath(recordingPath);
  const [sourceStats, previewStats] = await Promise.all([
    fs.stat(recordingPath),
    fs.stat(previewPath).catch(() => null),
  ]);

  if (!sourceStats || sourceStats.size < 512) {
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
      throw new Error("Could not decode this FLAC recording for in-app playback.");
    }
  }

  return previewPath;
};

module.exports = {
  ensurePlaybackPreview,
};
