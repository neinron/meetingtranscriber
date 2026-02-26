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

const sendStatus = (status, timestamp = Date.now(), filepath = null, details = "") => {
  if (!global.mainWindow || global.mainWindow.isDestroyed()) {
    return;
  }

  global.mainWindow.webContents.send("recording-status", status, timestamp, filepath, details);
};

const sendAudioLevels = (systemLevel = 0, micLevel = 0) => {
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

const stopRecorderProcess = ({ forceAfterMs = 2000 } = {}) => {
  if (!recordingProcess) return;
  if (recordingProcess.killed) {
    recordingProcess = null;
    return;
  }

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
    stdoutBuffer = "";
    stderrBuffer = "";

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
          sendStatus("START_RECORDING", timestamp, response.path);
          resolveOnce(true);
          continue;
        }

        if (response.code === "RECORDING_STOPPED") {
          const timestamp = new Date(response.timestamp).getTime();
          sendStatus("STOP_RECORDING", timestamp, response.path);
          sendAudioLevels(0, 0);
          continue;
        }

        if (response.code === "AUDIO_LEVELS") {
          sendAudioLevels(response.systemLevel || 0, response.micLevel || 0);
          continue;
        }

        if (response.code === "PERMISSION_DENIED") {
          sendStatus("START_FAILED", Date.now(), null, "Screen recording permission denied.");
        } else if (response.code) {
          sendStatus("START_FAILED", Date.now(), null, `Recorder error: ${response.code}`);
        }

        resolveOnce(false);
      }
    });

    recordingProcess.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
    });

    recordingProcess.on("error", (error) => {
      sendStatus("START_FAILED", Date.now(), null, `Recorder process failed to start: ${error.message}`);
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
        sendStatus("START_FAILED", Date.now(), null, details);
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
    global.mainWindow.loadFile(getPermissionDeniedScreenPath());
    sendStatus("START_FAILED", Date.now(), null, "Grant screen recording permission in System Settings and retry.");

    return;
  }

  const trimmedFilename = (filename ?? "").trim();
  if (trimmedFilename) {
    const fullPath = path.join(filepath, `${trimmedFilename}.flac`);
    if (fs.existsSync(fullPath)) {
      dialog.showMessageBox({
        type: "error",
        title: "Recording Error",
        message: "File already exists. Please choose a different filename or delete the existing file.",
        buttons: ["OK"],
      });

      global.mainWindow.loadFile(getRecordingScreenPath());
      sendStatus("START_FAILED", Date.now(), null, "A recording with this filename already exists.");

      return;
    }
  }

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const recordingStarted = await initRecording(filepath, trimmedFilename || null, micDeviceId);

    if (recordingStarted) {
      return;
    }
  }

  sendStatus("START_FAILED", Date.now(), null, "Failed to start recording after multiple attempts.");
};

module.exports.stopRecording = () => {
  stopRecorderProcess();
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
