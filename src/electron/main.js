const path = require("node:path");
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, systemPreferences } = require("electron");
const { loadEnv } = require("./utils/env");
loadEnv();

const { checkPermissions } = require("./utils/permission");
const { startRecording, stopRecording, listInputDevices, setRecordingObservers } = require("./utils/recording");
const { listRecordings } = require("./utils/recordings");
const { processRecordingWithGemini } = require("./utils/gemini");
const { getTranscriptPathForRecording, readMarkdown, saveMarkdown } = require("./utils/markdown");
const { getPermissionDeniedScreenPath, getRecordingScreenPath, getAppStoragePaths } = require("./utils/paths");
const { ensurePlaybackPreview } = require("./utils/playback");

const isDev = !app.isPackaged;
let tray = null;
let trayTickTimer = null;
let lastStartOptions = { filename: "", micDeviceId: null };
const trayState = {
  isRecording: false,
  startedAtMs: null,
  recordingName: "-",
  systemLevel: 0,
  micLevel: 0,
};

const logError = (context, error) => {
  const message = error?.stack || error?.message || String(error);
  // eslint-disable-next-line no-console
  console.error(`[${context}] ${message}`);
};

const getStoragePaths = () => getAppStoragePaths();

const ensureMicrophonePermission = async () => {
  if (process.platform !== "darwin") {
    return true;
  }

  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") {
    return true;
  }

  if (status === "not-determined") {
    try {
      return await systemPreferences.askForMediaAccess("microphone");
    } catch {
      return false;
    }
  }

  return false;
};

const requestMicrophonePermissionIfNeeded = async () => {
  try {
    return await ensureMicrophonePermission();
  } catch (error) {
    logError("microphone-permission", error);
    return false;
  }
};

const formatDuration = (startedAtMs) => {
  if (!startedAtMs) return "00:00:00";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
};

const toPercent = (value) => `${Math.round((value || 0) * 100)}%`;

const getDefaultFilename = () => {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `Meeting_Recording-${dd}${mm}${yyyy}-${hh}${min}`;
};

const openMainWindow = async () => {
  if (!global.mainWindow || global.mainWindow.isDestroyed()) {
    await createWindow();
    return;
  }

  if (global.mainWindow.isMinimized()) {
    global.mainWindow.restore();
  }
  global.mainWindow.show();
  global.mainWindow.focus();
};

const startRecordingFromTray = async () => {
  const { recordingsPath } = getStoragePaths();
  const filename = (lastStartOptions.filename || "").trim() || getDefaultFilename();

  await startRecording({
    filepath: recordingsPath,
    filename,
    micDeviceId: lastStartOptions.micDeviceId,
  });
};

const updateTrayMenu = () => {
  if (!tray) return;

  const totalLevel = Math.min(1, (trayState.systemLevel || 0) + (trayState.micLevel || 0));
  const template = [
    {
      label: "Open Scriby",
      click: () => {
        openMainWindow().catch((error) => logError("tray-open-window", error));
      },
    },
    {
      label: trayState.isRecording ? "Stop Recording" : "Start Recording",
      click: () => {
        if (trayState.isRecording) {
          stopRecording();
          return;
        }

        startRecordingFromTray().catch((error) => logError("tray-start-recording", error));
      },
    },
    { type: "separator" },
    { label: `Recording: ${trayState.recordingName || "-"}`, enabled: false },
    { label: `Length: ${formatDuration(trayState.startedAtMs)}`, enabled: false },
    {
      label: `Levels (S/M/T): ${toPercent(trayState.systemLevel)} / ${toPercent(trayState.micLevel)} / ${toPercent(totalLevel)}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Stop Scriby",
      click: () => app.quit(),
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(trayState.isRecording ? `Scriby • Recording ${formatDuration(trayState.startedAtMs)}` : "Scriby");
};

const setTrayTicking = (enabled) => {
  if (enabled) {
    if (trayTickTimer) return;
    trayTickTimer = setInterval(updateTrayMenu, 1000);
    return;
  }

  if (trayTickTimer) {
    clearInterval(trayTickTimer);
    trayTickTimer = null;
  }
};

const getTrayIcon = () => {
  const trayPngPath = path.join(app.getAppPath(), "assets", "tray", "menu-icon.png");
  const image = nativeImage.createFromPath(trayPngPath);

  if (image.isEmpty()) {
    return nativeImage.createEmpty();
  }

  const sized = image.resize({ width: 18, height: 18 });
  if (process.platform === "darwin") {
    sized.setTemplateImage(true);
  }
  return sized;
};

const setupTray = () => {
  if (tray) return;
  tray = new Tray(getTrayIcon());
  if (process.platform === "darwin") {
    tray.setTitle("");
  }
  tray.on("double-click", () => {
    openMainWindow().catch((error) => logError("tray-double-click", error));
  });
  updateTrayMenu();
};

const safeLoadScreen = async (screenPath) => {
  try {
    await global.mainWindow.loadFile(screenPath);
  } catch (error) {
    logError("load-screen", error);
  }
};

const createWindow = async () => {
  global.mainWindow = new BrowserWindow({
    width: 1200,
    height: 880,
    minWidth: 980,
    minHeight: 740,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      devTools: isDev,
    },
  });

  global.mainWindow.on("unresponsive", () => {
    logError("browser-window", new Error("Main window became unresponsive"));
  });

  global.mainWindow.on("closed", () => {
    global.mainWindow = null;
  });

  try {
    const isPermissionGranted = await checkPermissions();
    await requestMicrophonePermissionIfNeeded();

    if (isPermissionGranted) {
      await safeLoadScreen(getRecordingScreenPath());
    } else {
      await safeLoadScreen(getPermissionDeniedScreenPath());
    }
  } catch (error) {
    logError("startup-permissions", error);
    await safeLoadScreen(getPermissionDeniedScreenPath());
  }
};

ipcMain.on("start-recording", async (_, { filename, micDeviceId }) => {
  lastStartOptions = {
    filename: filename || "",
    micDeviceId: micDeviceId ?? null,
  };

  try {
    if (micDeviceId !== null) {
      const micGranted = await ensureMicrophonePermission();
      if (!micGranted) {
        if (global.mainWindow && !global.mainWindow.isDestroyed()) {
          global.mainWindow.webContents.send(
            "recording-status",
            "START_FAILED",
            Date.now(),
            null,
            "Microphone permission denied. Enable it in System Settings > Privacy & Security > Microphone."
          );
        }
        return;
      }
    }

    const { recordingsPath } = getStoragePaths();
    await startRecording({
      filepath: recordingsPath,
      filename,
      micDeviceId,
    });
  } catch (error) {
    logError("start-recording", error);
    global.mainWindow.webContents.send("recording-status", "START_FAILED", Date.now(), null, error.message);
  }
});

ipcMain.on("stop-recording", () => {
  stopRecording();
});

ipcMain.handle("get-storage-paths", async () => {
  return getStoragePaths();
});

ipcMain.handle("list-recordings", async () => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  return listRecordings(recordingsPath, transcriptsPath);
});

ipcMain.handle("list-input-devices", async () => {
  const micGranted = await ensureMicrophonePermission();
  if (!micGranted) {
    throw new Error("Microphone permission denied. Enable it in System Settings > Privacy & Security > Microphone.");
  }
  return listInputDevices();
});

ipcMain.handle("process-recording", async (_, { filePath, model }) => {
  const { transcriptsPath } = getStoragePaths();
  const markdown = await processRecordingWithGemini({ filePath, model });
  const transcriptPath = getTranscriptPathForRecording(filePath, transcriptsPath);

  await saveMarkdown(transcriptPath, markdown);

  return {
    transcriptPath,
    markdown,
  };
});

ipcMain.handle("load-markdown", async (_, markdownPath) => {
  const content = await readMarkdown(markdownPath);
  return { content };
});

ipcMain.handle("save-markdown", async (_, { markdownPath, content }) => {
  await saveMarkdown(markdownPath, content);
  return { ok: true };
});

ipcMain.handle("open-path", async (_, targetPath) => {
  await shell.openPath(targetPath);
  return { ok: true };
});

ipcMain.handle("get-playback-source", async (_, recordingPath) => {
  const previewPath = await ensurePlaybackPreview(recordingPath);
  return { playbackPath: previewPath };
});

ipcMain.handle("check-permissions", async () => {
  let isPermissionGranted = false;
  try {
    isPermissionGranted = await checkPermissions();
    await requestMicrophonePermissionIfNeeded();
  } catch (error) {
    logError("check-permissions", error);
    await dialog.showMessageBox(global.mainWindow, {
      type: "error",
      title: "Permission Check Failed",
      message: "Could not verify screen recording permission. Please restart the app and try again.",
      buttons: ["OK"],
    });
    return { ok: false };
  }

  if (isPermissionGranted) {
    await safeLoadScreen(getRecordingScreenPath());
  } else {
    const response = await dialog.showMessageBox(global.mainWindow, {
      type: "warning",
      title: "Permission Denied",
      message: "You need to grant permission for screen recording. Would you like to open System Preferences now?",
      buttons: ["Open System Preferences", "Cancel"],
    });

    if (response.response === 0) {
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
  }

  return { ok: true };
});

process.on("uncaughtException", (error) => {
  logError("uncaught-exception", error);
  stopRecording();
});

process.on("unhandledRejection", (reason) => {
  logError("unhandled-rejection", reason);
  stopRecording();
});

app.on("before-quit", () => {
  setTrayTicking(false);
  stopRecording();
});

app.on("window-all-closed", () => {
  stopRecording();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.whenReady().then(createWindow).catch((error) => {
  logError("app-ready", error);
});

setRecordingObservers({
  onStatus: ({ status, timestamp, filepath }) => {
    if (status === "START_RECORDING") {
      trayState.isRecording = true;
      trayState.startedAtMs = Number.isFinite(timestamp) ? timestamp : Date.now();
      trayState.recordingName = filepath ? path.basename(filepath) : "-";
      setTrayTicking(true);
      updateTrayMenu();
      return;
    }

    if (status === "STOP_RECORDING") {
      trayState.isRecording = false;
      trayState.startedAtMs = null;
      trayState.recordingName = "-";
      trayState.systemLevel = 0;
      trayState.micLevel = 0;
      setTrayTicking(false);
      updateTrayMenu();
      return;
    }

    if (status === "START_FAILED") {
      trayState.isRecording = false;
      trayState.startedAtMs = null;
      trayState.systemLevel = 0;
      trayState.micLevel = 0;
      setTrayTicking(false);
      updateTrayMenu();
    }
  },
  onLevels: ({ systemLevel, micLevel }) => {
    trayState.systemLevel = systemLevel || 0;
    trayState.micLevel = micLevel || 0;
    updateTrayMenu();
  },
});

app.whenReady().then(() => {
  setupTray();
}).catch((error) => {
  logError("tray-init", error);
});
