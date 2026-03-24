const path = require("path");
const fs = require("fs");
const os = require("os");
const { app } = require("electron");

const getRecorderBinaryPath = () => {
  if (app.isPackaged) {
    const packagedCandidates = [
      path.join(path.dirname(process.execPath), "Recorder"),
      path.join(process.resourcesPath, "Recorder"),
      path.join(process.resourcesPath, "app.asar.unpacked", "src", "swift", "Recorder"),
      path.join(app.getAppPath(), "src", "swift", "Recorder"),
    ];

    for (const candidatePath of packagedCandidates) {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      try {
        fs.chmodSync(candidatePath, 0o755);
      } catch {
        // Ignore chmod failures and let the later spawn/exec path surface a real error if needed.
      }

      return candidatePath;
    }

    throw new Error("Bundled recorder binary not found in packaged app resources.");
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

const copyMissingFiles = (sourceDir, targetDir) => {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  ensureDirectory(targetDir);

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
};

const expandHomePath = (value) => {
  if (!value) return value;
  return value.replace(/^~(?=$|[\\/])/, os.homedir());
};

const resolveConfiguredDirectory = (configuredPath, fallbackPath, basePath = null) => {
  if (!configuredPath) {
    return fallbackPath;
  }

  const expandedPath = expandHomePath(configuredPath.trim());
  if (!expandedPath) {
    return fallbackPath;
  }

  if (path.isAbsolute(expandedPath)) {
    return expandedPath;
  }

  return path.join(basePath || process.cwd(), expandedPath);
};

const getAppStoragePaths = () => {
  const defaultRootPath = path.join(os.homedir(), "Documents", "Meetlify");
  const rootPath = ensureDirectory(resolveConfiguredDirectory(process.env.MEETLIFY_STORAGE_ROOT, defaultRootPath));
  const recordingsPath = ensureDirectory(resolveConfiguredDirectory(process.env.MEETLIFY_RECORDINGS_DIR, path.join(rootPath, "Recordings"), rootPath));
  const transcriptsPath = ensureDirectory(resolveConfiguredDirectory(process.env.MEETLIFY_TRANSCRIPTS_DIR, path.join(rootPath, "Transcripts"), rootPath));
  const legacyRootPath = path.join(app.getPath("userData"), "storage");
  const legacyRecordingsPath = path.join(legacyRootPath, "recordings");
  const legacyTranscriptsPath = path.join(legacyRootPath, "transcripts");

  copyMissingFiles(legacyRecordingsPath, recordingsPath);
  copyMissingFiles(legacyTranscriptsPath, transcriptsPath);

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
