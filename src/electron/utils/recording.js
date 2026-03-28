const { spawn, execFile } = require("node:child_process");
const util = require("node:util");
const fs = require("fs");
const path = require("path");
const { dialog } = require("electron");
const { checkPermissions } = require("./permission");
const { getRecorderBinaryPath, getPermissionDeniedScreenPath, getRecordingScreenPath } = require("./paths");
const execFileAsync = util.promisify(execFile);

let recordingProcess = null;
let stdoutBuffer = "";
let stderrBuffer = "";
let forceKillTimer = null;
let statusObserver = null;
let levelsObserver = null;
let currentRecordingPath = null;
let currentRecordingName = "";
let currentStartedAtMs = null;
let userInitiatedStop = false;
let recorderLastError = "";
let recorderLastStartError = "";
let desiredFinalFilename = "";

const sendStatus = (status, timestamp = Date.now(), filepath = null, details = "") => {
  if (typeof statusObserver === "function") {
    try {
      statusObserver({ status, timestamp, filepath, details });
    } catch {
      // Non-fatal observer errors.
    }
  }

  if (!global.mainWindow || global.mainWindow.isDestroyed()) {
    return;
  }

  global.mainWindow.webContents.send("recording-status", status, timestamp, filepath, details);
};

const getRecordingSnapshot = () => ({
  isRecording: Boolean(recordingProcess),
  startedAtMs: currentStartedAtMs,
  recordingPath: currentRecordingPath,
  recordingName: currentRecordingName,
  userInitiatedStop,
  lastStopReason: recorderLastError,
});

const sendAudioLevels = (systemLevel = 0, micLevel = 0) => {
  if (typeof levelsObserver === "function") {
    try {
      levelsObserver({ systemLevel, micLevel });
    } catch {
      // Non-fatal observer errors.
    }
  }

  if (!global.mainWindow || global.mainWindow.isDestroyed()) {
    return;
  }

  global.mainWindow.webContents.send("recording-levels", {
    systemLevel,
    micLevel,
  });
};

const parseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const sanitizeFilename = (value) => (value || "")
  .trim()
  .replace(/[/:*?"<>|]/g, "-")
  .replace(/\s+/g, " ");

const resolveUniqueRecordingPath = (directory, baseName, extension = ".flac", originalPath = null) => {
  const sanitizedBaseName = sanitizeFilename(baseName);
  if (!directory || !sanitizedBaseName) {
    return originalPath || null;
  }

  let candidatePath = path.join(directory, `${sanitizedBaseName}${extension}`);
  let suffix = 1;
  while (fs.existsSync(candidatePath) && candidatePath !== originalPath) {
    candidatePath = path.join(directory, `${sanitizedBaseName}-${suffix}${extension}`);
    suffix += 1;
  }

  return candidatePath;
};

const resolveFinalRecordingPath = (originalPath) => {
  const sanitizedBaseName = sanitizeFilename(desiredFinalFilename);
  if (!originalPath || !sanitizedBaseName) {
    return originalPath;
  }

  const directory = path.dirname(originalPath);
  const extension = path.extname(originalPath) || ".flac";
  const originalBaseName = path.basename(originalPath, extension);
  if (sanitizedBaseName === originalBaseName) {
    return originalPath;
  }

  return resolveUniqueRecordingPath(directory, sanitizedBaseName, extension, originalPath);
};

const finalizeRecordingPath = (originalPath) => {
  const targetPath = resolveFinalRecordingPath(originalPath);
  if (!originalPath || !targetPath || originalPath === targetPath) {
    return originalPath;
  }

  try {
    fs.renameSync(originalPath, targetPath);
    return targetPath;
  } catch (error) {
    recorderLastError = `Could not apply final recording name: ${error.message}`;
    return originalPath;
  }
};

const validateRecordingFolder = async (folderPath) => {
  try {
    const stats = await fs.promises.stat(folderPath);
    if (!stats.isDirectory()) {
      return "Selected recording folder is not a directory.";
    }
    await fs.promises.access(folderPath, fs.constants.W_OK);
    return null;
  } catch (error) {
    return `Cannot write to selected folder: ${error?.message || "Unknown error"}`;
  }
};

const clearForceKillTimer = () => {
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }
};

const stopRecorderProcess = ({ forceAfterMs = 2000, initiatedByUser = false } = {}) => {
  if (!recordingProcess) return;
  if (recordingProcess.killed) {
    recordingProcess = null;
    return;
  }

  userInitiatedStop = initiatedByUser;

  try {
    recordingProcess.kill("SIGINT");
  } catch {
    recordingProcess = null;
    clearForceKillTimer();
    return;
  }

  clearForceKillTimer();
  forceKillTimer = setTimeout(() => {
    if (!recordingProcess || recordingProcess.killed) return;
    try {
      recordingProcess.kill("SIGKILL");
    } catch {
      // Ignore secondary kill failures.
    } finally {
      recordingProcess = null;
      forceKillTimer = null;
    }
  }, forceAfterMs);
};

const initRecording = (filepath, filename, micDeviceId) => {
  return new Promise((resolve) => {
    let settled = false;
    let hasStarted = false;
    stdoutBuffer = "";
    stderrBuffer = "";
    recorderLastError = "";
    recorderLastStartError = "";
    userInitiatedStop = false;
    desiredFinalFilename = filename ? sanitizeFilename(filename) : "";

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const args = ["--record", filepath];
    if (filename) args.push("--filename", filename);
    if (micDeviceId === null) {
      args.push("--no-mic");
    } else if (micDeviceId) {
      args.push("--mic-device-id", micDeviceId);
    }

    recordingProcess = spawn(getRecorderBinaryPath(), args);
    const currentProcess = recordingProcess;

    recordingProcess.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      const responses = lines.map(parseJsonLine).filter(Boolean);

      for (const response of responses) {
        if (response.code === "RECORDING_STARTED") {
          const timestamp = new Date(response.timestamp).getTime();
          hasStarted = true;
          currentRecordingPath = response.path || null;
          currentRecordingName = response.path ? path.basename(response.path) : "";
          currentStartedAtMs = timestamp;
          sendStatus("START_RECORDING", timestamp, response.path);
          resolveOnce(true);
          continue;
        }

        if (response.code === "RECORDING_STOPPED") {
          const timestamp = new Date(response.timestamp).getTime();
          const stopDetails = recorderLastError;
          const finalizedPath = stopDetails ? response.path : finalizeRecordingPath(response.path);
          sendStatus("STOP_RECORDING", timestamp, finalizedPath);
          if (stopDetails) {
            sendStatus("RECORDING_STOPPED_UNEXPECTEDLY", timestamp, finalizedPath, stopDetails);
          }
          sendAudioLevels(0, 0);
          currentRecordingPath = null;
          currentRecordingName = "";
          currentStartedAtMs = null;
          recorderLastError = "";
          userInitiatedStop = false;
          desiredFinalFilename = "";
          continue;
        }

        if (response.code === "AUDIO_LEVELS") {
          sendAudioLevels(response.systemLevel || 0, response.micLevel || 0);
          continue;
        }

        if (response.code === "STREAM_ERROR" || response.code === "RECORDER_RUNTIME_ERROR") {
          recorderLastError = response.message || response.details || "Recording stopped unexpectedly.";
          continue;
        }

        if (hasStarted) {
          recorderLastError = response.message || response.details || `Recorder error: ${response.code}`;
          continue;
        }

        if (response.code === "PERMISSION_DENIED") {
          recorderLastStartError = "Screen recording permission denied.";
          sendStatus("START_FAILED", Date.now(), null, recorderLastStartError);
        } else if (response.code) {
          recorderLastStartError = `Recorder error: ${response.code}`;
          sendStatus("START_FAILED", Date.now(), null, recorderLastStartError);
        }

        resolveOnce(false);
      }
    });

    recordingProcess.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
    });

    recordingProcess.on("error", (error) => {
      recorderLastError = `Recorder process failed to start: ${error.message}`;
      recorderLastStartError = recorderLastError;
      sendStatus("START_FAILED", Date.now(), null, recorderLastStartError);
      resolveOnce(false);
    });
    recordingProcess.on("exit", (code, signal) => {
      if (recordingProcess === currentProcess) {
        recordingProcess = null;
      }
      clearForceKillTimer();

      if (code && code !== 0) {
        const stderrMessage = stderrBuffer.trim();
        const details = stderrMessage
          ? `Recorder exited with code ${code}. ${stderrMessage}`
          : `Recorder exited with code ${code}${signal ? ` (signal ${signal})` : ""}.`;
        if (hasStarted) {
          recorderLastError = recorderLastError || details;
        } else {
          recorderLastStartError = details;
          sendStatus("START_FAILED", Date.now(), null, details);
        }
      } else if (hasStarted && !userInitiatedStop && !recorderLastError && signal && signal !== "SIGINT") {
        recorderLastError = `Recorder exited unexpectedly${signal ? ` (${signal})` : ""}.`;
      }

      if (hasStarted && currentRecordingPath && recorderLastError) {
        const stopTimestamp = Date.now();
        sendStatus("STOP_RECORDING", stopTimestamp, currentRecordingPath);
        sendStatus("RECORDING_STOPPED_UNEXPECTEDLY", stopTimestamp, currentRecordingPath, recorderLastError);
        sendAudioLevels(0, 0);
        currentRecordingPath = null;
        currentRecordingName = "";
        currentStartedAtMs = null;
        recorderLastError = "";
        userInitiatedStop = false;
        desiredFinalFilename = "";
      }

      resolveOnce(false);
    });
  });
};

module.exports.startRecording = async ({ filepath, filename, micDeviceId }) => {
  const folderError = await validateRecordingFolder(filepath);
  if (folderError) {
    sendStatus("START_FAILED", Date.now(), null, folderError);
    return;
  }

  let isPermissionGranted = false;
  try {
    isPermissionGranted = await checkPermissions();
  } catch (error) {
    sendStatus("START_FAILED", Date.now(), null, error.message);
    return;
  }

  if (!isPermissionGranted) {
    if (global.mainWindow && !global.mainWindow.isDestroyed()) {
      global.mainWindow.loadFile(getPermissionDeniedScreenPath());
    }
    sendStatus("START_FAILED", Date.now(), null, "Grant screen recording permission in System Settings and retry.");

    return;
  }

  const trimmedFilename = (filename ?? "").trim();
  const resolvedFilename = trimmedFilename
    ? path.basename(resolveUniqueRecordingPath(filepath, trimmedFilename, ".flac") || "", ".flac")
    : null;

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const recordingStarted = await initRecording(filepath, resolvedFilename, micDeviceId);

    if (recordingStarted) {
      return;
    }
  }

  sendStatus(
    "START_FAILED",
    Date.now(),
    null,
    recorderLastStartError || "Failed to start recording after multiple attempts."
  );
};

module.exports.stopRecording = () => {
  stopRecorderProcess({ initiatedByUser: true });
};

module.exports.stopRecordingForShutdown = () => {
  stopRecorderProcess({ initiatedByUser: true, forceAfterMs: 4000 });
};

module.exports.updateRecordingFilename = (filename) => {
  desiredFinalFilename = sanitizeFilename(filename);
};

module.exports.listInputDevices = async () => {
  const recorderBinaryPath = getRecorderBinaryPath();
  const { stdout } = await execFileAsync(recorderBinaryPath, ["--list-input-devices"], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    if (parsed.code === "INPUT_DEVICES") {
      return parsed.devices || [];
    }
    if (parsed.code === "MIC_PERMISSION_DENIED") {
      throw new Error("Microphone permission denied. Allow microphone access in macOS settings for this app.");
    }
  }

  throw new Error("Failed to list microphone devices.");
};

module.exports.setRecordingObservers = ({ onStatus, onLevels } = {}) => {
  statusObserver = typeof onStatus === "function" ? onStatus : null;
  levelsObserver = typeof onLevels === "function" ? onLevels : null;
};

module.exports.getRecordingSnapshot = getRecordingSnapshot;
