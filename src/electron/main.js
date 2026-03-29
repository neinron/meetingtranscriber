const path = require("node:path");
const fsPromises = require("node:fs/promises");
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
  setRecordingObservers,
  getRecordingSnapshot,
} = require("./utils/recording");
const {
  ERROR_STATUS,
  NEEDS_REVIEW_STATUS,
  READY_STATUS,
  createRecordingEntry,
  deleteRecording,
  ensureNormalizedAudio,
  getRecordingById,
  importMediaFiles,
  listRecordings,
  removeRecordingEntry,
  renameRecording,
  sanitizeDisplayName,
  SUPPORTED_MEDIA_FILTER_EXTENSIONS,
  synchronizeLibraryState,
  updateRecordingEntry,
  updateRecordingTranscriptPath,
} = require("./utils/recordings");
const { processRecordingWithGemini } = require("./utils/gemini");
const {
  getGeminiSettingsSummary,
  saveGeminiApiKey,
  saveTranscriptionPrompt,
  getUiDisclosureState,
  saveUiDisclosureState,
  getThemeMode,
  saveThemeMode,
  getAppSessionState,
  saveAppSessionState,
} = require("./utils/settings");
const { getTranscriptPathForRecording, readMarkdown, saveMarkdown } = require("./utils/markdown");
const { getPermissionDeniedScreenPath, getRecordingScreenPath, getAppStoragePaths } = require("./utils/paths");
const { ensurePlaybackPreview } = require("./utils/playback");
const { exportRecordingToMp3 } = require("./utils/export");
const { getRecordingAnalysis } = require("./utils/recording-analysis");
const { getExchangeRate } = require("./utils/exchange-rate");
const { getTranscriptionModels, estimateGeminiCost } = require("./utils/gemini-models");
const {
  appendInternalLog,
  getInternalLogPath,
  getRecentInternalLogs,
  subscribeInternalLog,
} = require("./utils/internal-log");
const { createTaskCoordinator } = require("./utils/task-coordinator");

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
  recordingId: null,
  isRecording: false,
  startedAtMs: null,
  recordingPath: null,
  recordingName: "",
  userInitiatedStop: false,
  lastStopReason: "",
};
const activeTranscriptionControllers = new Map();
const activeLibraryOperationCounts = new Map();
const inFlightTaskResults = new Map();
const TRANSCRIPTION_TASK_TIMEOUT_MS = 90 * 60 * 1000;
const operationCoordinator = createTaskCoordinator({
  laneLimits: {
    recordingControl: 1,
    library: 1,
    transcription: 2,
    media: 2,
    metadata: 4,
  },
  onEvent: (event, taskSnapshot) => {
    appendInternalLog("task-coordinator", event, taskSnapshot);
  },
});

const logError = (context, error) => {
  const message = error?.stack || error?.message || String(error);
  // eslint-disable-next-line no-console
  console.error(`[${context}] ${message}`);
  appendInternalLog("main-error", context, { message });
};

const withTaskTimeout = async (operation, timeoutMs, message) => {
  let timeoutHandle = null;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const getStoragePaths = () => getAppStoragePaths();
const getActiveLibraryIds = () => Array.from(activeLibraryOperationCounts.keys());
const markLibraryActive = (recordingId) => {
  if (!recordingId) {
    return false;
  }
  const previousCount = activeLibraryOperationCounts.get(recordingId) || 0;
  activeLibraryOperationCounts.set(recordingId, previousCount + 1);
  return previousCount === 0;
};
const unmarkLibraryActive = (recordingId) => {
  if (!recordingId) {
    return false;
  }
  const previousCount = activeLibraryOperationCounts.get(recordingId) || 0;
  if (previousCount <= 1) {
    activeLibraryOperationCounts.delete(recordingId);
    return previousCount > 0;
  }
  activeLibraryOperationCounts.set(recordingId, previousCount - 1);
  return false;
};
const hasActiveLibraryOperation = (recordingId) => Boolean(recordingId && activeLibraryOperationCounts.has(recordingId));
const registerTranscriptionController = (recordingId, controller) => {
  if (recordingId && controller) {
    activeTranscriptionControllers.set(recordingId, controller);
  }
};
const unregisterTranscriptionController = (recordingId, controller = null) => {
  if (!recordingId) {
    return;
  }
  if (controller && activeTranscriptionControllers.get(recordingId) !== controller) {
    return;
  }
  activeTranscriptionControllers.delete(recordingId);
};
const cancelActiveTranscription = (recordingId) => {
  const controller = activeTranscriptionControllers.get(recordingId);
  if (!controller) {
    return false;
  }
  controller.abort();
  return true;
};

const withInFlightTask = (taskKey, factory) => {
  if (!taskKey) {
    return factory();
  }

  if (inFlightTaskResults.has(taskKey)) {
    return inFlightTaskResults.get(taskKey);
  }

  const taskPromise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (inFlightTaskResults.get(taskKey) === taskPromise) {
        inFlightTaskResults.delete(taskKey);
      }
    });

  inFlightTaskResults.set(taskKey, taskPromise);
  return taskPromise;
};

const getPermissionSummary = () => {
  const microphoneStatus = process.platform === "darwin"
    ? systemPreferences.getMediaAccessStatus("microphone")
    : "granted";
  const screenStatus = process.platform === "darwin"
    ? systemPreferences.getMediaAccessStatus("screen")
    : "granted";

  return {
    microphone: {
      status: microphoneStatus,
      granted: microphoneStatus === "granted",
      message: getMicrophonePermissionMessage(microphoneStatus),
    },
    screen: {
      status: screenStatus,
      granted: screenStatus === "granted",
      message: screenStatus === "granted"
        ? "Screen recording permission is granted."
        : "Screen recording permission is required to capture system audio and screen content.",
    },
  };
};

const safeSend = (channel, ...args) => {
  if (!global.mainWindow || global.mainWindow.isDestroyed()) {
    return;
  }

  global.mainWindow.webContents.send(channel, ...args);
};

subscribeInternalLog((entry) => {
  safeSend("internal-log-entry", entry);
});

const syncRecorderStateFromSnapshot = () => {
  Object.assign(recorderState, getRecordingSnapshot());
};

const refreshLibraryState = async () => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  return synchronizeLibraryState(recordingsPath, transcriptsPath, {
    activeIds: getActiveLibraryIds(),
  });
};

const getLibraryRecordingById = async (recordingId) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  return getRecordingById(recordingsPath, transcriptsPath, recordingId, {
    activeIds: getActiveLibraryIds(),
  });
};

const updateLibraryRecording = async (recordingId, patch) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  return updateRecordingEntry(recordingsPath, recordingId, patch, transcriptsPath);
};

const getAppBootstrapState = async () => {
  const storagePaths = getStoragePaths();
  syncRecorderStateFromSnapshot();

  const [geminiSettings, recordings, uiState, taskState] = await Promise.all([
    getGeminiSettingsSummary(),
    listRecordings(storagePaths.recordingsPath, storagePaths.transcriptsPath, {
      activeIds: getActiveLibraryIds(),
    }),
    Promise.resolve({
      disclosureState: getUiDisclosureState(),
      themeMode: getThemeMode(),
      sessionState: getAppSessionState(),
    }),
    Promise.resolve(operationCoordinator.getSnapshot()),
  ]);

  return {
    storagePaths,
    geminiSettings,
    permissions: getPermissionSummary(),
    recordingState: { ...recorderState },
    taskState,
    recordings,
    uiState,
  };
};

const broadcastLibraryUpdated = () => {
  safeSend("library-updated");
};

const queueRecordingTask = ({
  recordingId,
  name,
  lane = "metadata",
  blockLibrary = false,
  broadcastActivity = false,
  task,
}) => {
  const lockKey = recordingId ? `recording:${recordingId}` : null;
  const shouldBroadcastStart = blockLibrary && markLibraryActive(recordingId);
  if (shouldBroadcastStart && broadcastActivity) {
    broadcastLibraryUpdated();
  }

  return operationCoordinator.schedule({
    name,
    lane,
    lockKey,
    recordingId,
    task,
  }).finally(() => {
    const shouldBroadcastEnd = blockLibrary && unmarkLibraryActive(recordingId);
    if (shouldBroadcastEnd && broadcastActivity) {
      broadcastLibraryUpdated();
    }
  });
};

const queueGlobalTask = ({
  name,
  lane = "library",
  lockKey = "library",
  task,
}) => operationCoordinator.schedule({
  name,
  lane,
  lockKey,
  task,
});

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

const hasMicrophonePermission = () => (
  process.platform !== "darwin"
  || systemPreferences.getMediaAccessStatus("microphone") === "granted"
);

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

const hasScreenPermission = () => (
  process.platform !== "darwin"
  || systemPreferences.getMediaAccessStatus("screen") === "granted"
);

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
          queueGlobalTask({
            name: "tray-stop-recording",
            lane: "recordingControl",
            lockKey: "recorder",
            task: async () => {
              if (!recorderState.recordingId && !recorderState.isRecording) {
                return;
              }

              recorderState.userInitiatedStop = true;
              if (recorderState.recordingId) {
                await updateLibraryRecording(recorderState.recordingId, {
                  status: "stopping",
                  lastError: null,
                }).catch((error) => logError("tray-recording-stop-status", error));
                broadcastLibraryUpdated();
              }
              safeSend("recording-status", "STOPPING_RECORDING", Date.now(), recorderState.recordingPath, "");
              stopRecording();
            },
          }).catch((error) => logError("tray-stop-recording", error));
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
    title: "Recording ended unexpectedly",
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
    await safeLoadScreen(getRecordingScreenPath());
    global.mainWindow.show();
  } catch (error) {
    logError("startup-permissions", error);
    await safeLoadScreen(getPermissionDeniedScreenPath());
    global.mainWindow.show();
  }

  syncDockVisibility();
};

const reserveRecordingForStart = async (displayName) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  const entry = await createRecordingEntry({
    recordingsFolderPath: recordingsPath,
    transcriptsFolderPath: transcriptsPath,
    displayName: sanitizeDisplayName(displayName || getDefaultFilename(), getDefaultFilename()),
    mediaExt: ".flac",
    mediaType: "audio",
    origin: "recorded",
    status: "recording",
  });

  recorderState.recordingId = entry.id;
  recorderState.recordingName = entry.displayName;
  recorderState.recordingPath = entry.mediaPath;
  recorderState.lastStopReason = "";
  markLibraryActive(entry.id);
  broadcastLibraryUpdated();
  return entry;
};

const cleanupReservedRecording = async (recordingId) => {
  if (!recordingId) {
    return;
  }

  const entry = await getLibraryRecordingById(recordingId);
  if (entry?.mediaPath) {
    await fsPromises.rm(entry.mediaPath, { force: true }).catch(() => {});
  }

  const { recordingsPath } = getStoragePaths();
  await removeRecordingEntry(recordingsPath, recordingId);
  unmarkLibraryActive(recordingId);
  broadcastLibraryUpdated();
};

const startReservedRecording = async ({ recordingEntry, micDeviceId }) => {
  await startRecording({
    filepath: path.dirname(recordingEntry.mediaPath),
    filename: recordingEntry.id,
    micDeviceId,
  });
};

const startRecordingFromTray = async () => {
  return queueGlobalTask({
    name: "start-recording-from-tray",
    lane: "recordingControl",
    lockKey: "recorder",
    task: async () => {
      if (recorderState.recordingId || recorderState.isRecording) {
        throw new Error("A recording is already in progress or finalizing.");
      }

      const displayName = (lastStartOptions.filename || "").trim() || getDefaultFilename();
      const micDeviceId = lastStartOptions.micDeviceId ?? null;

      if (micDeviceId !== null) {
        const micGranted = await ensureMicrophonePermission();
        if (!micGranted) {
          safeSend("recording-status", "START_FAILED", Date.now(), null, getMicrophonePermissionMessage());
          return;
        }
      }

      const recordingEntry = await reserveRecordingForStart(displayName);

      try {
        await startReservedRecording({
          recordingEntry,
          micDeviceId,
        });
      } catch (error) {
        await cleanupReservedRecording(recordingEntry.id).catch(() => {});
        throw error;
      }
    },
  });
};

ipcMain.on("start-recording", async (_, { filename, micDeviceId }) => {
  lastStartOptions = {
    filename: filename || "",
    micDeviceId: micDeviceId ?? null,
  };
  recorderState.userInitiatedStop = false;
  recorderState.lastStopReason = "";

  queueGlobalTask({
    name: "start-recording",
    lane: "recordingControl",
    lockKey: "recorder",
    task: async () => {
      if (recorderState.recordingId || recorderState.isRecording) {
        safeSend("recording-status", "START_FAILED", Date.now(), null, "A recording is already in progress or finalizing.");
        return;
      }

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

      const recordingEntry = await reserveRecordingForStart(filename);
      await startReservedRecording({
        recordingEntry,
        micDeviceId,
      });
    },
  }).catch(async (error) => {
    logError("start-recording", error);
    if (recorderState.recordingId) {
      await cleanupReservedRecording(recorderState.recordingId).catch(() => {});
      recorderState.recordingId = null;
      recorderState.recordingPath = null;
      recorderState.recordingName = "";
    }
    safeSend("recording-status", "START_FAILED", Date.now(), null, error.message);
  });
});

ipcMain.on("stop-recording", async () => {
  queueGlobalTask({
    name: "stop-recording",
    lane: "recordingControl",
    lockKey: "recorder",
    task: async () => {
      if (!recorderState.recordingId && !recorderState.isRecording) {
        return;
      }

      recorderState.userInitiatedStop = true;
      if (recorderState.recordingId) {
        await updateLibraryRecording(recorderState.recordingId, {
          status: "stopping",
          lastError: null,
        }).catch((error) => logError("recording-stop-status", error));
        broadcastLibraryUpdated();
      }
      safeSend("recording-status", "STOPPING_RECORDING", Date.now(), recorderState.recordingPath, "");
      stopRecording();
    },
  }).catch((error) => logError("stop-recording", error));
});

ipcMain.on("update-recording-filename", (_, { filename }) => {
  lastStartOptions.filename = filename || "";
  const nextDisplayName = sanitizeDisplayName(filename || getDefaultFilename(), getDefaultFilename());

  if (recorderState.recordingId) {
    updateLibraryRecording(recorderState.recordingId, {
      displayName: nextDisplayName,
    }).catch((error) => logError("recording-rename-live", error));
    recorderState.recordingName = nextDisplayName;
    trayState.recordingName = recorderState.recordingName || "-";
    updateTrayMenu();
    broadcastLibraryUpdated();
  }
});

ipcMain.handle("get-storage-paths", async () => getStoragePaths());
ipcMain.handle("get-internal-log-path", async () => ({ logPath: getInternalLogPath() }));
ipcMain.handle("get-recent-internal-logs", async (_, { limit = 250 } = {}) => ({
  entries: getRecentInternalLogs(limit),
}));

ipcMain.handle("get-gemini-settings", async () => getGeminiSettingsSummary());

ipcMain.handle("save-gemini-api-key", async (_, { apiKey }) => saveGeminiApiKey(apiKey));
ipcMain.handle("save-transcription-prompt", async (_, { prompt }) => ({
  transcriptionPrompt: saveTranscriptionPrompt(prompt),
}));

ipcMain.handle("get-ui-state", async () => ({
  disclosureState: getUiDisclosureState(),
  themeMode: getThemeMode(),
  sessionState: getAppSessionState(),
}));

ipcMain.handle("set-disclosure-state", async (_, disclosureState) => ({
  disclosureState: saveUiDisclosureState(disclosureState),
}));

ipcMain.handle("set-app-session-state", async (_, sessionState) => ({
  sessionState: saveAppSessionState(sessionState),
}));

ipcMain.handle("set-theme-mode", async (_, themeMode) => ({
  themeMode: saveThemeMode(themeMode),
}));

ipcMain.handle("get-app-bootstrap-state", async () => getAppBootstrapState());

ipcMain.handle("get-recording-state", async () => {
  syncRecorderStateFromSnapshot();
  return { ...recorderState };
});

ipcMain.handle("get-task-coordinator-state", async () => operationCoordinator.getSnapshot());

ipcMain.handle("get-transcription-models", async () => {
  const models = getTranscriptionModels();
  return {
    models,
    defaultModelId: models.find((model) => model.id === "gemini-2.5-pro")?.id || models[0]?.id || "",
  };
});

ipcMain.handle("get-recording-analysis", async (_, { recordingId, filePath, model }) => {
  if (!recordingId) {
    if (!filePath) {
      throw new Error("Recording not found.");
    }
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
  }

  return withInFlightTask(`recording-analysis:${recordingId}:${model || ""}`, () => queueRecordingTask({
    recordingId,
    name: "recording-analysis",
    lane: "media",
    blockLibrary: true,
    task: async () => {
      const resolvedPath = (await getLibraryRecordingById(recordingId))?.mediaPath;
      const recording = await getLibraryRecordingById(recordingId);
      if (!resolvedPath || !recording) {
        throw new Error("Recording not found.");
      }

      if (["transcribing", "importing", "recording", "stopping", "finalizing"].includes(recording.status)) {
        const exchangeRate = await getExchangeRate();
        const estimate = estimateGeminiCost({
          durationSeconds: recording.durationSeconds || 0,
          modelId: model,
          eurPerUsd: exchangeRate.eurPerUsd,
        });

        return {
          path: recording.mediaPath,
          sizeBytes: recording.sizeBytes,
          durationSeconds: recording.durationSeconds,
          exchangeRate,
          estimate,
        };
      }

      const analysis = await getRecordingAnalysis(resolvedPath);
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
    },
  }));
});

ipcMain.handle("list-recordings", async () => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  return listRecordings(recordingsPath, transcriptsPath, {
    activeIds: getActiveLibraryIds(),
  });
});

ipcMain.handle("get-recording-by-id", async (_, { recordingId }) => {
  const recording = await getLibraryRecordingById(recordingId);
  if (!recording) {
    throw new Error("Recording not found.");
  }

  return recording;
});

ipcMain.handle("list-input-devices", async () => {
  const micGranted = hasMicrophonePermission();
  if (!micGranted) {
    throw new Error(getMicrophonePermissionMessage());
  }
  return listInputDevices();
});

ipcMain.handle("get-microphone-permission-status", async () => ({
  status: systemPreferences.getMediaAccessStatus("microphone"),
  message: getMicrophonePermissionMessage(),
}));

ipcMain.handle("import-media", async () => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  const response = await dialog.showOpenDialog(global.mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Supported Media",
        extensions: SUPPORTED_MEDIA_FILTER_EXTENSIONS,
      },
      {
        name: "All Files",
        extensions: ["*"],
      },
    ],
  });

  if (response.canceled || !response.filePaths.length) {
    return { imported: [] };
  }

  const result = await queueGlobalTask({
    name: "import-media",
    lane: "library",
    lockKey: "library",
    task: () => importMediaFiles({
      sourcePaths: response.filePaths,
      recordingsFolderPath: recordingsPath,
      transcriptsFolderPath: transcriptsPath,
    }),
  });
  broadcastLibraryUpdated();
  return result;
});

ipcMain.handle("rename-recording", async (_, { recordingId, displayName }) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  const recording = await queueRecordingTask({
    recordingId,
    name: "rename-recording",
    lane: "metadata",
    blockLibrary: true,
    task: async () => {
      const nextRecording = await renameRecording({
        recordingsFolderPath: recordingsPath,
        transcriptsFolderPath: transcriptsPath,
        recordingId,
        displayName,
      });

      if (!nextRecording) {
        throw new Error("Recording not found.");
      }

      return nextRecording;
    },
  });

  if (recorderState.recordingId === recordingId) {
    recorderState.recordingName = recording.displayName;
    trayState.recordingName = recording.displayName || "-";
    updateTrayMenu();
  }

  broadcastLibraryUpdated();
  return recording;
});

ipcMain.handle("delete-recording", async (_, { recordingId }) => {
  if (!recordingId) {
    throw new Error("Recording not found.");
  }

  if (recorderState.recordingId === recordingId || hasActiveLibraryOperation(recordingId) || operationCoordinator.hasRecordingTask(recordingId)) {
    throw new Error("This recording is currently in use and cannot be deleted yet.");
  }

  const { recordingsPath, transcriptsPath } = getStoragePaths();
  await queueRecordingTask({
    recordingId,
    name: "delete-recording",
    lane: "library",
    blockLibrary: true,
    task: async () => {
      const recording = await getRecordingById(recordingsPath, transcriptsPath, recordingId, {
        activeIds: getActiveLibraryIds(),
      });
      if (!recording) {
        throw new Error("Recording not found.");
      }

      await deleteRecording({
        recordingsFolderPath: recordingsPath,
        transcriptsFolderPath: transcriptsPath,
        recordingId,
      });
    },
  });
  broadcastLibraryUpdated();
  return { ok: true, recordingId };
});

ipcMain.handle("process-recording", async (_, { recordingId, model }) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  return queueRecordingTask({
    recordingId,
    name: "process-recording",
    lane: "transcription",
    blockLibrary: true,
    task: async () => {
      const recording = await getRecordingById(recordingsPath, transcriptsPath, recordingId, {
        activeIds: getActiveLibraryIds(),
      });
      if (!recording) {
        throw new Error("Recording not found.");
      }

      const updateTranscriptionProgress = async (statusDetail) => {
        appendInternalLog("transcription-progress", statusDetail, {
          recordingId: recording.id,
          model,
        });
        await updateRecordingEntry(recordingsPath, recording.id, {
          status: "transcribing",
          lastError: null,
          statusDetail,
        }, transcriptsPath);
        broadcastLibraryUpdated();
      };
      const abortController = new AbortController();
      registerTranscriptionController(recording.id, abortController);

      await updateRecordingEntry(recordingsPath, recording.id, {
        status: "transcribing",
        lastError: null,
        statusDetail: "Preparing audio...",
      }, transcriptsPath);
      appendInternalLog("transcription-progress", "Preparing audio...", {
        recordingId: recording.id,
        model,
      });
      broadcastLibraryUpdated();

      try {
        const sourceAudioPath = await ensureNormalizedAudio({
          recordingsFolderPath: recordingsPath,
          transcriptsFolderPath: transcriptsPath,
          recordingId: recording.id,
          activeIds: getActiveLibraryIds(),
        });
        const transcriptionResult = await withTaskTimeout(() => processRecordingWithGemini({
          filePath: sourceAudioPath,
          model,
          onProgress: updateTranscriptionProgress,
          signal: abortController.signal,
        }), TRANSCRIPTION_TASK_TIMEOUT_MS, "Transcription timed out. Please try again.");
        const transcriptPath = getTranscriptPathForRecording(recording.id, transcriptsPath);

        await updateTranscriptionProgress("Saving transcript...");
        await saveMarkdown(transcriptPath, transcriptionResult.markdown);
        await updateRecordingTranscriptPath({
          recordingsFolderPath: recordingsPath,
          transcriptsFolderPath: transcriptsPath,
          recordingId: recording.id,
          transcriptPath,
        });
        const terminalStatus = transcriptionResult.status === NEEDS_REVIEW_STATUS
          ? NEEDS_REVIEW_STATUS
          : READY_STATUS;
        await updateRecordingEntry(recordingsPath, recording.id, {
          status: terminalStatus,
          lastError: null,
          statusDetail: terminalStatus === NEEDS_REVIEW_STATUS
            ? "Gemini returned low-confidence transcript content. Review before relying on it."
            : null,
          qualityFlags: transcriptionResult.qualityFlags || [],
          lastTranscriptionModel: model,
          lastTranscriptionCompletedAt: new Date().toISOString(),
        }, transcriptsPath);
        appendInternalLog("transcription-completed", "Transcript saved successfully.", {
          recordingId: recording.id,
          model,
          transcriptPath,
          status: terminalStatus,
          qualityFlags: transcriptionResult.qualityFlags || [],
          validation: transcriptionResult.validation || null,
        });
        broadcastLibraryUpdated();

        return {
          status: terminalStatus,
          qualityFlags: transcriptionResult.qualityFlags || [],
          transcriptPath,
          markdown: transcriptionResult.markdown,
        };
      } catch (error) {
        const transcriptPath = getTranscriptPathForRecording(recording.id, transcriptsPath);
        await fsPromises.unlink(transcriptPath).catch(() => {});
        if (error?.code === "TRANSCRIPTION_ABORTED") {
          appendInternalLog("transcription-aborted", "Transcription stopped by user.", {
            recordingId: recording.id,
            model,
          });
          await updateRecordingEntry(recordingsPath, recording.id, {
            status: READY_STATUS,
            lastError: null,
            statusDetail: null,
          }, transcriptsPath).catch(() => {});
          broadcastLibraryUpdated();
          return {
            canceled: true,
          };
        }
        appendInternalLog("transcription-failed", error.message, {
          recordingId: recording.id,
          model,
          qualityFlags: error?.qualityFlags || [],
          validation: error?.validation || null,
        });
        await updateRecordingEntry(recordingsPath, recording.id, {
          status: ERROR_STATUS,
          lastError: error.message,
          statusDetail: null,
          qualityFlags: error?.qualityFlags || [],
          lastTranscriptionModel: model,
        }, transcriptsPath).catch(() => {});
        broadcastLibraryUpdated();
        throw error;
      } finally {
        unregisterTranscriptionController(recording.id, abortController);
      }
    },
  });
});

ipcMain.handle("accept-transcript", async (_, { recordingId }) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  const recording = await queueRecordingTask({
    recordingId,
    name: "accept-transcript",
    lane: "metadata",
    blockLibrary: true,
    task: async () => {
      const nextRecording = await updateRecordingEntry(recordingsPath, recordingId, {
        status: READY_STATUS,
        statusDetail: null,
        qualityFlags: [],
      }, transcriptsPath);

      if (!nextRecording) {
        throw new Error("Recording not found.");
      }

      return nextRecording;
    },
  });

  broadcastLibraryUpdated();
  return recording;
});

ipcMain.handle("cancel-transcription", async (_, { recordingId }) => {
  if (!recordingId) {
    throw new Error("Recording not found.");
  }

  const didCancel = cancelActiveTranscription(recordingId);
  if (!didCancel) {
    throw new Error("No active transcription found for this recording.");
  }

  return { ok: true, recordingId };
});

ipcMain.handle("export-recording-mp3", async (_, { recordingId, chunked }) => {
  return queueRecordingTask({
    recordingId,
    name: "export-recording-mp3",
    lane: "media",
    blockLibrary: true,
    task: async () => {
      const recording = await getLibraryRecordingById(recordingId);
      if (!recording) {
        throw new Error("Recording not found.");
      }

      if (["transcribing", "finalizing", "importing", "recording", "stopping"].includes(recording.status)) {
        throw new Error("Export is unavailable while this item is still being processed.");
      }

      return exportRecordingToMp3({
        filePath: recording.mediaPath,
        chunked: Boolean(chunked),
        outputBaseName: sanitizeDisplayName(recording.displayName, "Meeting"),
      });
    },
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

ipcMain.handle("save-markdown", async (_, { recordingId, markdownPath, content }) => {
  const { recordingsPath, transcriptsPath } = getStoragePaths();
  return queueRecordingTask({
    recordingId,
    name: "save-markdown",
    lane: "metadata",
    blockLibrary: true,
    task: async () => {
      const recording = await getRecordingById(recordingsPath, transcriptsPath, recordingId, {
        activeIds: getActiveLibraryIds(),
      });
      if (!recording) {
        throw new Error("Recording not found.");
      }
      const resolvedMarkdownPath = getTranscriptPathForRecording(recording.id, transcriptsPath);

      await updateRecordingTranscriptPath({
        recordingsFolderPath: recordingsPath,
        transcriptsFolderPath: transcriptsPath,
        recordingId: recording.id,
        transcriptPath: resolvedMarkdownPath,
      });

      await saveMarkdown(resolvedMarkdownPath, content);
      broadcastLibraryUpdated();
      return { ok: true, transcriptPath: resolvedMarkdownPath };
    },
  });
});

ipcMain.handle("open-path", async (_, targetPath) => {
  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  return { ok: true };
});

ipcMain.handle("get-playback-source", async (_, { recordingId }) => {
  return withInFlightTask(`get-playback-source:${recordingId}`, () => queueRecordingTask({
    recordingId,
    name: "get-playback-source",
    lane: "media",
    blockLibrary: true,
    task: async () => {
      const recording = await getLibraryRecordingById(recordingId);
      if (!recording) {
        throw new Error("Recording not found.");
      }

      if (["transcribing", "importing", "recording", "stopping", "finalizing"].includes(recording.status)) {
        throw new Error("Playback is unavailable while transcription is in progress.");
      }

      const previewPath = await ensurePlaybackPreview(recording.mediaPath);
      return { playbackPath: previewPath };
    },
  }));
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

  if (!isPermissionGranted) {
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

  return {
    ok: isPermissionGranted,
    permissions: getPermissionSummary(),
  };
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
    permissions: getPermissionSummary(),
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
  onStatus: async ({ status, timestamp, filepath, details }) => {
    appendInternalLog("recording-status", status, { timestamp, filepath, details });
    if (status === "START_RECORDING") {
      if (recorderState.recordingId) {
        await updateLibraryRecording(recorderState.recordingId, {
          status: "recording",
          mediaPath: filepath || recorderState.recordingPath,
          lastError: null,
        }).catch((error) => logError("recording-start-library", error));
      }
      recorderState.isRecording = true;
      recorderState.startedAtMs = Number.isFinite(timestamp) ? timestamp : Date.now();
      recorderState.recordingPath = filepath || null;
      recorderState.lastStopReason = "";
      recorderState.userInitiatedStop = false;

      trayState.isRecording = true;
      trayState.startedAtMs = recorderState.startedAtMs;
      trayState.recordingName = recorderState.recordingName || "-";
      setTrayTicking(true);
      updateTrayMenu();
      broadcastLibraryUpdated();
      return;
    }

    if (status === "STOP_RECORDING") {
      const stoppingRecordingId = recorderState.recordingId;
      if (stoppingRecordingId) {
        try {
          let recordingStats = null;
          let finalizationError = details || "";
          const finalRecordingPath = filepath || recorderState.recordingPath;

          if (finalRecordingPath && !finalizationError) {
            try {
              recordingStats = await fsPromises.stat(finalRecordingPath);
            } catch (error) {
              if (error?.code === "ENOENT") {
                finalizationError = "Final recording file is missing.";
              } else {
                throw error;
              }
            }
          }

          await updateLibraryRecording(stoppingRecordingId, {
            status: finalizationError ? ERROR_STATUS : READY_STATUS,
            mediaPath: finalRecordingPath,
            sizeBytes: recordingStats?.size ?? null,
            lastError: finalizationError || null,
          });
        } catch (error) {
          logError("recording-stop-library", error);
        } finally {
          unmarkLibraryActive(stoppingRecordingId);
        }
      }
      recorderState.isRecording = false;
      recorderState.startedAtMs = null;
      recorderState.recordingPath = null;
      recorderState.recordingName = "";
      recorderState.recordingId = null;
      recorderState.lastStopReason = "";
      recorderState.userInitiatedStop = false;

      trayState.isRecording = false;
      trayState.startedAtMs = null;
      trayState.recordingName = "-";
      trayState.systemLevel = 0;
      trayState.micLevel = 0;
      setTrayTicking(false);
      updateTrayMenu();
      broadcastLibraryUpdated();
      return;
    }

    if (status === "RECORDING_STOPPED_UNEXPECTEDLY") {
      recorderState.lastStopReason = details || "Recording stopped unexpectedly.";
      const failedRecordingId = recorderState.recordingId;
      if (failedRecordingId) {
        await updateLibraryRecording(failedRecordingId, {
          status: ERROR_STATUS,
          lastError: recorderState.lastStopReason,
        }).catch((error) => logError("recording-unexpected-library", error));
        unmarkLibraryActive(failedRecordingId);
      }
      if (!recorderState.userInitiatedStop) {
        showUnexpectedStopNotification({
          filepath,
          details: recorderState.lastStopReason,
        });
      }
      recorderState.isRecording = false;
      recorderState.startedAtMs = null;
      recorderState.recordingPath = null;
      recorderState.recordingName = "";
      recorderState.userInitiatedStop = false;
      recorderState.recordingId = null;

      trayState.isRecording = false;
      trayState.startedAtMs = null;
      trayState.recordingName = "-";
      trayState.systemLevel = 0;
      trayState.micLevel = 0;
      setTrayTicking(false);
      updateTrayMenu();
      broadcastLibraryUpdated();
      return;
    }

    if (status === "START_FAILED") {
      if (recorderState.recordingId) {
        await cleanupReservedRecording(recorderState.recordingId).catch((error) => logError("recording-start-failed-cleanup", error));
      }
      recorderState.isRecording = false;
      recorderState.startedAtMs = null;
      recorderState.recordingPath = null;
      recorderState.recordingName = "";
      recorderState.recordingId = null;
      recorderState.lastStopReason = details || "";
      recorderState.userInitiatedStop = false;

      trayState.isRecording = false;
      trayState.startedAtMs = null;
      trayState.systemLevel = 0;
      trayState.micLevel = 0;
      setTrayTicking(false);
      updateTrayMenu();
      broadcastLibraryUpdated();
    }
  },
  onLevels: ({ systemLevel, micLevel }) => {
    trayState.systemLevel = systemLevel || 0;
    trayState.micLevel = micLevel || 0;
    updateTrayMenu();
  },
});

app.whenReady().then(async () => {
  appendInternalLog("app-start", "Meetlify session initialized", {
    version: app.getVersion(),
    pid: process.pid,
    platform: process.platform,
  });
  await refreshLibraryState();
  setupTray();
  await createWindow();
  syncDockVisibility();
}).catch((error) => {
  logError("app-ready", error);
});
