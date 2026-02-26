const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { loadEnv } = require("./utils/env");
loadEnv();

const { checkPermissions } = require("./utils/permission");
const { startRecording, stopRecording, listInputDevices } = require("./utils/recording");
const { listRecordings } = require("./utils/recordings");
const { processRecordingWithGemini } = require("./utils/gemini");
const { getTranscriptPathForRecording, readMarkdown, saveMarkdown } = require("./utils/markdown");
const { getPermissionDeniedScreenPath, getRecordingScreenPath, getAppStoragePaths } = require("./utils/paths");

const isDev = !app.isPackaged;

const logError = (context, error) => {
  const message = error?.stack || error?.message || String(error);
  // eslint-disable-next-line no-console
  console.error(`[${context}] ${message}`);
};

const getStoragePaths = () => getAppStoragePaths();

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
    stopRecording();
    global.mainWindow = null;
  });

  try {
    const isPermissionGranted = await checkPermissions();

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
  try {
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

ipcMain.handle("check-permissions", async () => {
  let isPermissionGranted = false;
  try {
    isPermissionGranted = await checkPermissions();
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
