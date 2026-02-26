const path = require("path");
const fs = require("fs");
const { app } = require("electron");

let cachedPackagedRecorderPath = null;

const getRecorderBinaryPath = () => {
  if (app.isPackaged) {
    if (cachedPackagedRecorderPath) {
      return cachedPackagedRecorderPath;
    }

    const bundledRecorderPath = path.join(app.getAppPath(), "src", "swift", "Recorder");
    const extractedDir = path.join(app.getPath("userData"), "bin");
    const extractedRecorderPath = path.join(extractedDir, "Recorder");

    if (!fs.existsSync(extractedDir)) {
      fs.mkdirSync(extractedDir, { recursive: true });
    }

    if (!fs.existsSync(extractedRecorderPath)) {
      fs.copyFileSync(bundledRecorderPath, extractedRecorderPath);
      fs.chmodSync(extractedRecorderPath, 0o755);
    }

    cachedPackagedRecorderPath = extractedRecorderPath;
    return extractedRecorderPath;
  }

  return path.join(app.getAppPath(), "src", "swift", "Recorder");
};

const getRecordingScreenPath = () => path.join(__dirname, "..", "screens", "recording", "screen.html");
const getPermissionDeniedScreenPath = () => path.join(__dirname, "..", "screens", "permission-denied", "screen.html");

const ensureDirectory = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
};

const getAppStoragePaths = () => {
  const rootPath = ensureDirectory(path.join(app.getPath("userData"), "storage"));
  const recordingsPath = ensureDirectory(path.join(rootPath, "recordings"));
  const transcriptsPath = ensureDirectory(path.join(rootPath, "transcripts"));

  return {
    rootPath,
    recordingsPath,
    transcriptsPath,
  };
};

module.exports = {
  getRecorderBinaryPath,
  getRecordingScreenPath,
  getPermissionDeniedScreenPath,
  getAppStoragePaths,
};
