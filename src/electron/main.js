const path = require("node:path");
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  Tray,
  nativeImage,
  systemPreferences,
  desktopCapturer,
  Notification,
} = require("electron");
const { loadEnv } = require("./utils/env");
loadEnv();

const {
  startRecording,
  stopRecording,
  stopRecordingForShutdown,
  listInputDevices,
  updateRecordingFilename,
  setRecordingObservers,
  getRecordingSnapshot,
} = require("./utils/recording");
const { listRecordings, updateRecordingTranscriptPath } = require("./utils/recordings");
const { processRecordingWithGemini } = require("./utils/gemini");
const { getGeminiSettingsSummary, saveGeminiApiKey, saveTranscriptionPrompt, getUiDisclosureState, saveUiDisclosureState, getThemeMode, saveThemeMode } = require("./utils/settings");
const { getTranscriptPathForRecording, readMarkdown, saveMarkdown } = require("./utils/markdown");
const { getPermissionDeniedScreenPath, getRecordingScreenPath, getAppStoragePaths } = require("./utils/paths");
const { ensurePlaybackPreview } = require("./utils/playback");
const { exportRecordingToMp3 } = require("./utils/export");
const { getRecordingAnalysis } = require("./utils/recording-analysis");
const { getExchangeRate } = require("./utils/exchange-rate");
const { getTranscriptionModels, estimateGeminiCost } = require("./utils/gemini-models");

const isDev = !app.isPackaged;
let tray = null;
let trayTickTimer = null;
let isQuitting = false;
let lastStartOptions = { filename: "", micDeviceId: null };
const trayState = {
  isRecording: false,
  startedAtMs: null,
  recordingName: "-",
  systemLevel: 0,
  micLevel: 0,
};
const recorderState = {
  isRecording: false,
  startedAtMs: null,
  recordingPath: null,
  recordingName: "",
  userInitiatedStop: false,
  lastStopReason: "",
};

const logError = (context, error) => {
  const message = error?.stack || error?.message || String(error);
  // eslint-disable-next-line no-console
  console.error(`[${context}] ${message}`);
};

const getStoragePaths = () => getAppStoragePaths();

const safeSend = (channel, ...args) => {
  if (!global.mainWindow || global.mainWindow.isDestroyed()) {
    return;
  }

  global.mainWindow.webContents.send(channel, ...args);
};

const syncRecorderStateFromSnapshot = () => {
  Object.assign(recorderState, getRecordingSnapshot());
};

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

const getMicrophonePermissionMessage = (status = systemPreferences.getMediaAccessStatus("microphone")) => {
  if (status === "denied" || status === "restricted") {
    return "Microphone access was previously denied. Open System Settings > Privacy & Security > Microphone, enable Meetlify, then relaunch the app.";
  }

  return "Meetlify could not get microphone access. Trigger the microphone prompt from inside the app and accept it when macOS asks.";
};

const openMicrophoneSettings = async () => {
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
};

const ensureScreenPermissionFromApp = async () => {
  if (process.platform !== "darwin") {
    return true;
  }

  const currentStatus = systemPreferences.getMediaAccessStatus("screen");
  if (currentStatus === "granted") {
    return true;
  }

  if (currentStatus === "not-determined") {
    try {
      await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
    } catch (error) {
      logError("screen-permission-request", error);
    }
  }

  return systemPreferences.getMediaAccessStatus("screen") === "granted";
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

const syncDockVisibility = () => {
  if (process.platform !== "darwin" || !app.dock) {
    return;
  }

  const shouldShowDock = Boolean(global.mainWindow && !global.mainWindow.isDestroyed() && global.mainWindow.isVisible());
  try {
    if (shouldShowDock) {
      app.dock.show();
    } else {
      app.dock.hide();
    }
  } catch (error) {
    logError("sync-dock-visibility", error);
  }
};

const openMainWindow = async () => {
  if (!global.mainWindow || global.mainWindow.isDestroyed()) {
    await createWindow();
    syncDockVisibility();
    return;
  }

  if (global.mainWindow.isMinimized()) {
    global.mainWindow.restore();
  }

  global.mainWindow.show();
  global.mainWindow.focus();
  syncDockVisibility();
};

const updateTrayMenu = () => {
  if (!tray) return;

  const totalLevel = Math.min(1, (trayState.systemLevel || 0) + (trayState.micLevel || 0));
  const liveLength = formatDuration(trayState.startedAtMs);
  const template = [
    {
      label: "Open Meetlify",
      click: () => {
        openMainWindow().catch((error) => logError("tray-open-window", error));
      },
    },
    {
      label: trayState.isRecording ? "Stop Recording" : "Start Recording",
      click: () => {
        if (trayState.isRecording) {
          recorderState.userInitiatedStop = true;
          stopRecording();
          return;
        }

        startRecordingFromTray().catch((error) => logError("tray-start-recording", error));
      },
    },
    { type: "separator" },
    {
      label: `Levels (S/M/T): ${toPercent(trayState.systemLevel)} / ${toPercent(trayState.micLevel)} / ${toPercent(totalLevel)}`,
      enabled: false,
    },
    { label: `Meeting: ${trayState.recordingName || "-"}`, enabled: false },
    { label: `Length: ${liveLength}`, enabled: false },
    { type: "separator" },
    {
      label: "Stop Meetlify",
      click: () => app.quit(),
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(trayState.isRecording ? `Meetlify • Recording ${formatDuration(trayState.startedAtMs)}` : "Meetlify");
  if (process.platform === "darwin") {
    tray.setTitle(trayState.isRecording ? "Recording" : "");
  }
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
  const traySvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <path d="M9 2.4a2.7 2.7 0 0 0-2.7 2.7v3.8A2.7 2.7 0 0 0 9 11.6a2.7 2.7 0 0 0 2.7-2.7V5.1A2.7 2.7 0 0 0 9 2.4z" fill="black"/>
      <path d="M4.7 8.4a.8.8 0 0 1 .8.8 3.5 3.5 0 0 0 7 0 .8.8 0 0 1 1.6 0A5.1 5.1 0 0 1 9.8 14v1.4h2a.8.8 0 0 1 0 1.6H6.2a.8.8 0 0 1 0-1.6h2V14A5.1 5.1 0 0 1 3.9 9.2a.8.8 0 0 1 .8-.8z" fill="black"/>
    </svg>
  `.trim();
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(traySvg)}`);

  if (image.isEmpty()) {
    const trayPngPath = path.join(app.getAppPath(), "assets", "tray", "menu-icon.png");
    const fallbackImage = nativeImage.createFromPath(trayPngPath);
    if (fallbackImage.isEmpty()) {
      return nativeImage.createEmpty();
    }
    const fallbackSized = fallbackImage.resize({ width: 18, height: 18 });
    if (process.platform === "darwin") {
      fallbackSized.setTemplateImage(true);
    }
    return fallbackSized;
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
  tray.on("double-click", () => {
    openMainWindow().catch((error) => logError("tray-double-click", error));
  });
  updateTrayMenu();
};

const destroyTray = () => {
  setTrayTicking(false);
  if (!tray) return;

  try {
    tray.destroy();
  } catch (error) {
    logError("tray-destroy", error);
  } finally {
    tray = null;
  }
};

const safeLoadScreen = async (screenPath) => {
  try {
    await global.mainWindow.loadFile(screenPath);
  } catch (error) {
    logError("load-screen", error);
  }
};

const showUnexpectedStopNotification = ({ filepath, details }) => {
  if (!Notification.isSupported()) {
    return;
  }

  const bodyParts = [];
  if (details) {
    bodyParts.push(details);
  }
  if (filepath) {
    bodyParts.push(path.basename(filepath));
  }

  const notification = new Notification({
    title: "Recording stopped unexpectedly",
    body: bodyParts.join("\n"),
    silent: false,
  });

  notification.on("click", () => {
    openMainWindow().catch((error) => logError("notification-open-window", error));
    if (filepath) {
      shell.openPath(path.dirname(filepath)).catch(() => {});
    }
  });
  notification.show();
};

const createWindow = async () => {
  global.mainWindow = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 860,
    minHeight: 720,
    show: false,
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

  global.mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    isQuitting = true;
    stopRecordingForShutdown();
    destroyTray();
    app.quit();
  });

  global.mainWindow.on("show", () => {
    syncDockVisibility();
  });

  global.mainWindow.on("hide", () => {
    syncDockVisibility();
  });

  global.mainWindow.on("minimize", () => {
    syncDockVisibility();
  });

  global.mainWindow.on("closed", () => {
    global.mainWindow = null;
    syncDockVisibility();
  });

  try {
    const isPermissionGranted = await ensureScreenPermissionFromApp();

    if (isPermissionGranted) {
      await safeLoadScreen(getRecordingScreenPath());
      global.mainWindow.show();
    } else {
      await safeLoadScreen(getPermissionDeniedScreenPath());
      global.mainWindow.show();
    }
  } catch (error) {
    logError("startup-permissions", error);
    await safeLoadScreen(getPermissionDeniedScreenPath());
    global.mainWindow.show();
  }

  syncDockVisibility();

  requestMicrophonePermissionIfNeeded().catch((error) => {
    logError("startup-microphone-permission", error);
  });
};

const startRecordingFromTray = async () => {
  const { recordingsPath } = getStoragePaths();
  const filename = (lastStartOptions.filename || "").trim() || getDefaultFilename();
  const micDeviceId = lastStartOptions.micDeviceId ?? null;

  if (micDeviceId !== null) {
    const micGranted = await ensureMicrophonePermission();
    if (!micGranted) {
      safeSend("recording-status", "START_FAILED", Date.now(), null, getMicrophonePermissionMessage());
      return;
    }
  }

  await startRecording({
    filepath: recordingsPath,
    filename,
    micDeviceId,
  });
};

ipcMain.on("start-recording", async (_, { filename, micDeviceId }) => {
  lastStartOptions = {
    filename: filename || "",
    micDeviceId: micDeviceId ?? null,
  };
  recorderState.userInitiatedStop = false;

  try {
    const screenGranted = await ensureScreenPermissionFromApp();
    if (!screenGranted) {
      safeSend(
        "recording-status",
        "START_FAILED",
        Date.now(),
        null,
        "Screen recording permission denied. Enable it in System Settings > Privacy & Security > Screen Recording."
      );
      return;
    }

    if (micDeviceId !== null) {
      const micGranted = await ensureMicrophonePermission();
      if (!micGranted) {
        safeSend("recording-status", "START_FAILED", Date.now(), null, getMicrophonePermissionMessage());
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
    safeSend("recording-status", "START_FAILED", Date.now(), null, error.message);
  }
});

ipcMain.on("stop-recording", () => {
  recorderState.userInitiatedStop = true;
  stopRecording();
});

ipcMain.on("update-recording-filename", (_, { filename }) => {
  lastStartOptions.filename = filename || "";
  updateRecordingFilename(filename || "");

  if (recorderState.isRecording) {
    recorderState.recordingName = (filename || "").trim() || recorderState.recordingName;
    trayState.recordingName = recorderState.recordingName || "-";
    updateTrayMenu();
  }
});

ipcMain.handle("get-storage-paths", async () => getStoragePaths());

ipcMain.handle("get-gemini-settings", async () => getGeminiSettingsSummary());

ipcMain.handle("save-gemini-api-key", async (_, { apiKey }) => saveGeminiApiKey(apiKey));
ipcMain.handle("save-transcription-prompt", async (_, { prompt }) => ({
  transcriptionPrompt: saveTranscriptionPrompt(prompt),
}));

ipcMain.handle("get-ui-state", async () => ({
  disclosureState: getUiDisclosureState(),
  themeMode: getThemeMode(),
}));

ipcMain.handle("set-disclosure-state", async (_, disclosureState) => ({
  disclosureState: saveUiDisclosureState(disclosureState),
}));

ipcMain.handle("set-theme-mode", async (_, themeMode) => ({
  themeMode: saveThemeMode(themeMode),
}));

ipcMain.handle("get-recording-state", async () => {
  syncRecorderStateFromSnapshot();
  return { ...recorderState };
});

ipcMain.handle("get-transcription-models", async () => ({
  models: getTranscriptionModels(),
}));

ipcMain.handle("get-recording-analysis", async (_, { filePath, model }) => {
  const analysis = await getRecordingAnalysis(filePath);
  const exchangeRate = await getExchangeRate();
  const estimate = estimateGeminiCost({
    durationSeconds: analysis.durationSeconds || 0,
    modelId: model,
    eurPerUsd: exchangeRate.eurPerUsd,
  });

  return {
    ...analysis,
    exchangeRate,
    estimate,
  };
});

ipcMain.handle("list-recordings", async () => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  return listRecordings(recordingsPath, transcriptsPath);
});

ipcMain.handle("list-input-devices", async () => {
  const micGranted = await ensureMicrophonePermission();
  if (!micGranted) {
    throw new Error(getMicrophonePermissionMessage());
  }
  return listInputDevices();
});

ipcMain.handle("get-microphone-permission-status", async () => ({
  status: systemPreferences.getMediaAccessStatus("microphone"),
  message: getMicrophonePermissionMessage(),
}));

ipcMain.handle("process-recording", async (_, { filePath, model, transcriptPath: requestedTranscriptPath }) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  const markdown = await processRecordingWithGemini({ filePath, model });
  const transcriptPath = requestedTranscriptPath || getTranscriptPathForRecording(filePath, transcriptsPath);

  await saveMarkdown(transcriptPath, markdown);
  await updateRecordingTranscriptPath({
    recordingsFolderPath: recordingsPath,
    transcriptsFolderPath: transcriptsPath,
    audioPath: filePath,
    transcriptPath,
  });

  return {
    transcriptPath,
    markdown,
  };
});

ipcMain.handle("export-recording-mp3", async (_, { filePath, chunked }) => {
  return exportRecordingToMp3({
    filePath,
    chunked: Boolean(chunked),
  });
});

ipcMain.handle("load-markdown", async (_, markdownPath) => {
  try {
    const content = await readMarkdown(markdownPath);
    return { content, missing: false };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { content: "", missing: true };
    }
    throw error;
  }
});

ipcMain.handle("save-markdown", async (_, { markdownPath, content, filePath }) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  let resolvedMarkdownPath = markdownPath;

  if (!resolvedMarkdownPath) {
    if (!filePath) {
      throw new Error("Missing transcript target.");
    }
    resolvedMarkdownPath = getTranscriptPathForRecording(filePath, transcriptsPath);
    await updateRecordingTranscriptPath({
      recordingsFolderPath: recordingsPath,
      transcriptsFolderPath: transcriptsPath,
      audioPath: filePath,
      transcriptPath: resolvedMarkdownPath,
    });
  }

  await saveMarkdown(resolvedMarkdownPath, content);
  return { ok: true, transcriptPath: resolvedMarkdownPath };
});

ipcMain.handle("open-path", async (_, targetPath) => {
  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  return { ok: true };
});

ipcMain.handle("get-playback-source", async (_, recordingPath) => {
  const previewPath = await ensurePlaybackPreview(recordingPath);
  return { playbackPath: previewPath };
});

ipcMain.handle("check-permissions", async () => {
  let isPermissionGranted = false;
  try {
    isPermissionGranted = await ensureScreenPermissionFromApp();
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

ipcMain.handle("request-microphone-permission", async () => {
  const micGranted = await requestMicrophonePermissionIfNeeded();
  if (!micGranted) {
    const response = await dialog.showMessageBox(global.mainWindow, {
      type: "warning",
      title: "Microphone Permission Required",
      message: "Microphone access is not granted. Open System Settings now?",
      buttons: ["Open Settings", "Cancel"],
    });

    if (response.response === 0) {
      await openMicrophoneSettings();
    }
  }

  return {
    ok: micGranted,
    status: systemPreferences.getMediaAccessStatus("microphone"),
    message: micGranted ? "Microphone access granted." : getMicrophonePermissionMessage(),
  };
});

process.on("uncaughtException", (error) => {
  logError("uncaught-exception", error);
  stopRecordingForShutdown();
});

process.on("unhandledRejection", (reason) => {
  logError("unhandled-rejection", reason);
  stopRecordingForShutdown();
});

app.on("before-quit", () => {
  isQuitting = true;
  stopRecordingForShutdown();
  destroyTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    isQuitting = true;
    stopRecordingForShutdown();
    destroyTray();
    app.quit();
  }
});

app.on("activate", () => {
  openMainWindow().catch((error) => logError("app-activate", error));
});

setRecordingObservers({
  onStatus: ({ status, timestamp, filepath, details }) => {
    if (status === "START_RECORDING") {
      recorderState.isRecording = true;
      recorderState.startedAtMs = Number.isFinite(timestamp) ? timestamp : Date.now();
      recorderState.recordingPath = filepath || null;
      recorderState.recordingName = filepath ? path.basename(filepath) : "";
      recorderState.lastStopReason = "";
      recorderState.userInitiatedStop = false;

      trayState.isRecording = true;
      trayState.startedAtMs = recorderState.startedAtMs;
      trayState.recordingName = recorderState.recordingName || "-";
      setTrayTicking(true);
      updateTrayMenu();
      return;
    }

    if (status === "STOP_RECORDING") {
      recorderState.isRecording = false;
      recorderState.startedAtMs = null;
      recorderState.recordingPath = null;
      recorderState.recordingName = "";

      trayState.isRecording = false;
      trayState.startedAtMs = null;
      trayState.recordingName = "-";
      trayState.systemLevel = 0;
      trayState.micLevel = 0;
      setTrayTicking(false);
      updateTrayMenu();
      return;
    }

    if (status === "RECORDING_STOPPED_UNEXPECTEDLY") {
      recorderState.lastStopReason = details || "Recording stopped unexpectedly.";
      if (!recorderState.userInitiatedStop) {
        showUnexpectedStopNotification({
          filepath,
          details: recorderState.lastStopReason,
        });
      }
      recorderState.userInitiatedStop = false;
      return;
    }

    if (status === "START_FAILED") {
      recorderState.isRecording = false;
      recorderState.startedAtMs = null;
      recorderState.recordingPath = null;
      recorderState.recordingName = "";
      recorderState.lastStopReason = details || "";
      recorderState.userInitiatedStop = false;

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

app.whenReady().then(async () => {
  setupTray();
  await createWindow();
  syncDockVisibility();
}).catch((error) => {
  logError("app-ready", error);
});
