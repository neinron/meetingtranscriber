const { ipcRenderer, clipboard } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const MarkdownIt = require("markdown-it");

const markdownParser = new MarkdownIt({
  breaks: true,
  linkify: true,
});

const HISTORY_LIMIT = 100;
const DEBUG_ENTRY_LIMIT = 400;
const DISCLOSURE_SETTINGS_PANEL = "settingsPanel";
const SYSTEM_THEME_QUERY = window.matchMedia("(prefers-color-scheme: dark)");
const nativeConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let selectedFolderPath = "";
let transcriptsFolderPath = "";
let recordingFilename = "";
let selectedMicDeviceId = "";
let selectedRendererMicDeviceId = "";
let currentRecordingId = "";
let recordings = [];
let selectedRecordingId = "";
let transcriptPath = null;
let searchMatches = [];
let activeSearchIndex = -1;
let isRecording = false;
let isPendingStart = false;
let isPendingStop = false;
let recorderSystemLevel = 0;
let recorderMicLevel = 0;
let liveMonitorStream = null;
let liveMonitorAudioContext = null;
let liveMonitorAnalyser = null;
let liveMonitorData = null;
let liveMonitorFrame = null;
let liveMicLevel = 0;
let updateTimer = null;
let startTimeMs = null;
let modelCatalog = [];
let recordingAnalysis = null;
let themeMode = "system";
let settingsPanelOpen = false;
let currentView = "setup";
let previousPrimaryView = "setup";
let editorHistory = {
  undoStack: [],
  redoStack: [],
  currentValue: "",
};
let isApplyingHistory = false;
let promptHistory = {
  undoStack: [],
  redoStack: [],
  currentValue: "",
};
let isApplyingPromptHistory = false;
let lastSplit = 50;
let isPlaybackLoading = false;
let pendingMp3ExportResolve = null;
let pendingRetranscribeResolve = null;
let pendingDeleteResolve = null;
let sidebarWidth = 256;
let previousReviewTitle = "";
let selectionRequestId = 0;
let selectedRecordingHasTranscript = false;
let editorHeaderResizeObserver = null;
let currentStatusMessage = "Ready";
let isEditingRecordingTitle = false;
let hasCustomRecordingFilename = false;
let recordingFilenameClockTimer = null;
let isStartingTranscription = false;
let isStoppingTranscription = false;
let appShellState = "booting";
let appPermissions = null;
let bootstrapSessionState = {
  selectedRecordingId: "",
  lastPrimaryView: "setup",
};
let refreshRecordingsTimer = null;
let refreshRecordingsPromise = Promise.resolve();
let defaultTranscriptionModelId = "";
let debugConsoleOpen = false;
let debugConsoleEntries = [];
let debugConsoleHooksInstalled = false;

const BUSY_RECORDING_STATUSES = new Set(["recording", "stopping", "finalizing", "importing", "transcribing"]);
const HEAVY_SELECTION_BLOCKED_STATUSES = new Set(["recording", "stopping", "finalizing", "importing", "transcribing"]);

const statusDisplayEl = document.getElementById("status-display");
const sidebarNewRecordingEl = document.getElementById("sidebar-new-recording");
const sidebarRailNewRecordingEl = document.getElementById("sidebar-rail-new-recording");
const importRecordingsEl = document.getElementById("import-recordings");
const sidebarRailImportRecordingsEl = document.getElementById("sidebar-rail-import-recordings");
const refreshRecordingsEl = document.getElementById("refresh-recordings");
const recordingsListEl = document.getElementById("recordings-list");
const sidebarPaneEl = document.getElementById("sidebar-pane");
const sidebarRailEl = document.getElementById("sidebar-rail");
const collapseSidebarEl = document.getElementById("collapse-sidebar");
const restoreSidebarEl = document.getElementById("restore-sidebar");
const sidebarRailSettingsEl = document.getElementById("sidebar-rail-settings");
const sidebarResizerEl = document.getElementById("sidebar-resizer");
const settingsToggleEl = document.getElementById("settings-toggle");
const settingsPanelEl = document.getElementById("settings-panel");
const settingsChevronEl = document.getElementById("settings-chevron");
const settingsCloseEl = document.getElementById("settings-close");
const themeModeEl = document.getElementById("theme-mode");
const geminiKeyEl = document.getElementById("gemini-key");
const geminiKeyStatusEl = document.getElementById("gemini-key-status");
const saveApiKeyEl = document.getElementById("save-api-key");
const transcriptionPromptEl = document.getElementById("transcription-prompt");
const saveTranscriptionPromptEl = document.getElementById("save-transcription-prompt");
const checkPermissionsEl = document.getElementById("check-permissions");
const requestMicPermissionEl = document.getElementById("request-mic-permission");
const selectFolderEl = document.getElementById("select-folder");
const openTranscriptFolderEl = document.getElementById("open-transcript-folder");
const selectedFolderPathEl = document.getElementById("selected-folder-path");
const selectedTranscriptsPathEl = document.getElementById("selected-transcripts-path");
const setupViewEl = document.getElementById("setup-view");
const reviewViewEl = document.getElementById("review-view");
const promptViewEl = document.getElementById("prompt-view");
const recordingFilenameEl = document.getElementById("record-filename");
const editRecordingFilenameEl = document.getElementById("edit-record-filename");
const microphoneSelectEl = document.getElementById("mic-select");
const recordButtonEl = document.getElementById("record-btn");
const recordIconEl = document.getElementById("record-icon");
const timerDisplayEl = document.getElementById("timer-display");
const outputFilePathEl = document.getElementById("output-file-path");
const setupMetersEl = document.getElementById("setup-meters");
const meterSystemEl = document.getElementById("meter-system");
const meterMicEl = document.getElementById("meter-mic");
const reviewTitleEl = document.getElementById("review-title");
const openTranscriptButtonEl = document.getElementById("open-transcript-button");
const titleEditButtonEl = document.getElementById("title-edit-button");
const titleEditIconEl = document.getElementById("title-edit-icon");
const metaDateTimeEl = document.getElementById("meta-date-time");
const metaSizeEl = document.getElementById("meta-size");
const metaDurationStaticEl = document.getElementById("meta-duration-static");
const playerToggleEl = document.getElementById("player-toggle");
const playerToggleIconEl = document.getElementById("player-toggle-icon");
const playerSeekEl = document.getElementById("player-seek");
const playerProgressEl = document.getElementById("player-progress");
const currentTimeEl = document.getElementById("current-time");
const playerDurationLabelEl = document.getElementById("player-duration-label");
const recordingPlayerEl = document.getElementById("recording-player");
const modelSelectEl = document.getElementById("model-select");
const costEstimateEl = document.getElementById("cost-estimate");
const processButtonEl = document.getElementById("process-btn");
const processButtonTextEl = document.getElementById("process-btn-text");
const recordingAnalysisEl = document.getElementById("recording-analysis");
const modelDescriptionEl = document.getElementById("model-description");
const costEstimateDetailEl = document.getElementById("cost-estimate-detail");
const editorRailEl = document.getElementById("editor-rail");
const editorPaneEl = document.getElementById("editor-pane");
const collapseEditorEl = document.getElementById("collapse-editor");
const editorHeaderLayoutEl = document.getElementById("editor-header-layout");
const editorHeaderPrimaryEl = document.getElementById("editor-header-primary");
const editorHeaderToolsEl = document.getElementById("editor-header-tools");
const restoreEditorEl = document.getElementById("restore-editor");
const undoBtnEl = document.getElementById("undo-btn");
const redoBtnEl = document.getElementById("redo-btn");
const toggleFindEl = document.getElementById("toggle-find");
const toggleLabelsEl = document.getElementById("toggle-labels");
const saveBtnEl = document.getElementById("save-btn");
const saveBtnTextEl = document.getElementById("save-btn-text");
const saveBtnIconEl = document.getElementById("save-btn-icon");
const findBarEl = document.getElementById("find-bar");
const findInputEl = document.getElementById("find-input");
const replaceInputEl = document.getElementById("replace-input");
const findNowEl = document.getElementById("find-now");
const searchPrevEl = document.getElementById("search-prev");
const searchNextEl = document.getElementById("search-next");
const replaceOneEl = document.getElementById("replace-one");
const replaceAllEl = document.getElementById("replace-all");
const searchStatusEl = document.getElementById("search-status");
const labelsBarEl = document.getElementById("labels-bar");
const speakerDropdownEl = document.getElementById("speaker-dropdown");
const speakerLabelEl = document.getElementById("speaker-label");
const speakerNameEl = document.getElementById("speaker-name");
const replaceSpeakerEl = document.getElementById("replace-speaker");
const markdownEditorEl = document.getElementById("markdown-editor");
const resizerEl = document.getElementById("resizer");
const previewPaneEl = document.getElementById("preview-pane");
const collapsePreviewEl = document.getElementById("collapse-preview");
const previewRailEl = document.getElementById("preview-rail");
const restorePreviewEl = document.getElementById("restore-preview");
const copyMarkdownEl = document.getElementById("copy-markdown");
const exportMp3El = document.getElementById("export-mp3");
const deleteRecordingEl = document.getElementById("delete-recording");
const previewContentEl = document.getElementById("preview-content");
const workspaceContainerEl = document.getElementById("workspace-container");
const mp3ExportModalEl = document.getElementById("mp3-export-modal");
const mp3ExportSingleEl = document.getElementById("mp3-export-single");
const mp3ExportChunkedEl = document.getElementById("mp3-export-chunked");
const mp3ExportCancelEl = document.getElementById("mp3-export-cancel");
const retranscribeModalEl = document.getElementById("retranscribe-modal");
const retranscribeConfirmEl = document.getElementById("retranscribe-confirm");
const retranscribeCancelEl = document.getElementById("retranscribe-cancel");
const deleteRecordingModalEl = document.getElementById("delete-recording-modal");
const deleteRecordingNameEl = document.getElementById("delete-recording-name");
const deleteRecordingConfirmEl = document.getElementById("delete-recording-confirm");
const deleteRecordingCancelEl = document.getElementById("delete-recording-cancel");
const openTranscriptionPromptEl = document.getElementById("open-transcription-prompt");
const closePromptViewEl = document.getElementById("close-prompt-view");
const promptUndoBtnEl = document.getElementById("prompt-undo-btn");
const promptRedoBtnEl = document.getElementById("prompt-redo-btn");
const saveTranscriptionPromptTextEl = document.getElementById("save-transcription-prompt-text");
const saveTranscriptionPromptIconEl = document.getElementById("save-transcription-prompt-icon");
const appStateOverlayEl = document.getElementById("app-state-overlay");
const appStateEyebrowEl = document.getElementById("app-state-eyebrow");
const appStateTitleEl = document.getElementById("app-state-title");
const appStateBodyEl = document.getElementById("app-state-body");
const appStatePrimaryEl = document.getElementById("app-state-primary");
const appStateSecondaryEl = document.getElementById("app-state-secondary");
const reviewWarningBannerEl = document.getElementById("review-warning-banner");
const reviewWarningTextEl = document.getElementById("review-warning-text");
const reviewWarningRetryEl = document.getElementById("review-warning-retry");
const reviewWarningAcceptEl = document.getElementById("review-warning-accept");
const toggleDebugConsoleEl = document.getElementById("toggle-debug-console");
const debugConsolePanelEl = document.getElementById("debug-console-panel");
const debugConsoleOutputEl = document.getElementById("debug-console-output");
const copyDebugConsoleEl = document.getElementById("copy-debug-console");
const clearDebugConsoleEl = document.getElementById("clear-debug-console");
const closeDebugConsoleEl = document.getElementById("close-debug-console");

const renderIcons = () => {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons();
  }
  updateEditorHeaderLayout();
};

const getModeLabel = () => {
  if (currentView === "review") return "Editing Mode";
  if (currentView === "prompt") return "System Prompt Mode";
  return "Recording Mode";
};

const renderStatusMessage = () => {
  statusDisplayEl.textContent = `${getModeLabel()} · ${currentStatusMessage}`;
  searchStatusEl.textContent = currentStatusMessage;
};

const setStatusMessage = (message) => {
  currentStatusMessage = message;
  renderStatusMessage();
};

const setSelectedRecordingId = (nextRecordingId, { persist = true } = {}) => {
  selectedRecordingId = nextRecordingId || "";
  if (persist) {
    persistAppSessionState();
  }
};

const persistAppSessionState = () => ipcRenderer.invoke("set-app-session-state", {
  selectedRecordingId,
  lastPrimaryView: previousPrimaryView,
}).catch(() => {});

const stringifyDebugValue = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const normalizeDebugEntry = (entry) => {
  const payload = entry?.payload && typeof entry.payload === "object" ? { ...entry.payload } : {};
  delete payload.sessionId;
  const extra = Object.keys(payload).length ? stringifyDebugValue(payload) : "";
  const timestamp = entry?.timestamp || new Date().toISOString();
  const scope = entry?.scope || entry?.source || "renderer";
  const message = String(entry?.message || "").trim();
  const level = entry?.level || (
    /error|failed|exception|rejection/i.test(scope) ? "error"
      : (/warn|validation|needs_review/i.test(scope) ? "warn" : "info")
  );

  return {
    timestamp,
    scope,
    message,
    extra,
    level,
  };
};

const renderDebugConsole = () => {
  if (!debugConsoleOutputEl) {
    return;
  }

  debugConsoleOutputEl.innerHTML = "";
  if (!debugConsoleEntries.length) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "debug-console-empty";
    emptyEl.textContent = "Debug mode is active. New log entries will appear here.";
    debugConsoleOutputEl.appendChild(emptyEl);
    return;
  }

  const fragment = document.createDocumentFragment();
  debugConsoleEntries.forEach((entry) => {
    const rowEl = document.createElement("div");
    rowEl.className = `debug-console-entry ${entry.level === "error" ? "debug-error" : entry.level === "warn" ? "debug-warn" : ""}`.trim();

    const metaEl = document.createElement("div");
    metaEl.className = "debug-console-meta";
    const timeEl = document.createElement("span");
    timeEl.textContent = new Date(entry.timestamp).toLocaleTimeString();
    const scopeEl = document.createElement("span");
    scopeEl.className = "debug-console-scope";
    scopeEl.textContent = entry.scope;
    metaEl.append(timeEl, scopeEl);

    const bodyEl = document.createElement("div");
    bodyEl.textContent = entry.extra ? `${entry.message}\n${entry.extra}`.trim() : entry.message;

    rowEl.append(metaEl, bodyEl);
    fragment.appendChild(rowEl);
  });

  debugConsoleOutputEl.appendChild(fragment);
  debugConsoleOutputEl.scrollTop = debugConsoleOutputEl.scrollHeight;
};

const appendDebugEntry = (entry) => {
  debugConsoleEntries.push(normalizeDebugEntry(entry));
  if (debugConsoleEntries.length > DEBUG_ENTRY_LIMIT) {
    debugConsoleEntries = debugConsoleEntries.slice(-DEBUG_ENTRY_LIMIT);
  }
  renderDebugConsole();
};

const setDebugConsoleOpen = (open) => {
  debugConsoleOpen = Boolean(open);
  debugConsolePanelEl?.classList.toggle("hidden-panel", !debugConsoleOpen);
};

const loadDebugConsoleHistory = async () => {
  try {
    const result = await ipcRenderer.invoke("get-recent-internal-logs", { limit: 150 });
    debugConsoleEntries = Array.isArray(result?.entries) ? result.entries.map(normalizeDebugEntry) : [];
    renderDebugConsole();
  } catch (error) {
    appendDebugEntry({
      scope: "debug-console",
      message: "Failed to load debug history.",
      payload: { error: error?.message || String(error) },
      level: "warn",
    });
  }
};

const installDebugConsoleHooks = () => {
  if (debugConsoleHooksInstalled) {
    return;
  }
  debugConsoleHooksInstalled = true;

  ["log", "info", "warn", "error"].forEach((method) => {
    console[method] = (...args) => {
      nativeConsole[method](...args);
      appendDebugEntry({
        scope: `renderer:${method}`,
        message: args.map(stringifyDebugValue).join(" "),
        level: method === "error" ? "error" : method === "warn" ? "warn" : "info",
      });
    };
  });

  window.addEventListener("error", (event) => {
    appendDebugEntry({
      scope: "renderer:error",
      message: event.message || "Unhandled renderer error",
      payload: {
        filename: event.filename || "",
        lineno: event.lineno || 0,
        colno: event.colno || 0,
      },
      level: "error",
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    appendDebugEntry({
      scope: "renderer:unhandledrejection",
      message: stringifyDebugValue(event.reason),
      level: "error",
    });
  });
};

const setAppStateOverlay = ({
  visible = false,
  eyebrow = "App State",
  title = "",
  body = "",
  primaryLabel = "",
  secondaryLabel = "",
} = {}) => {
  appStateOverlayEl.classList.toggle("hidden-panel", !visible);
  appStateEyebrowEl.textContent = eyebrow;
  appStateTitleEl.textContent = title;
  appStateBodyEl.textContent = body;
  appStatePrimaryEl.classList.toggle("hidden-panel", !primaryLabel);
  appStateSecondaryEl.classList.toggle("hidden-panel", !secondaryLabel);
  appStatePrimaryEl.textContent = primaryLabel || "Continue";
  appStateSecondaryEl.textContent = secondaryLabel || "Cancel";
};

const updateShellState = (nextState = "setup") => {
  appShellState = nextState;

  if (nextState === "booting") {
    setAppStateOverlay({
      visible: true,
      eyebrow: "Boot",
      title: "Starting Meetlify",
      body: "Loading your library, recorder state, and current session.",
    });
    return;
  }

  if (nextState === "needs_screen_permission") {
    setAppStateOverlay({
      visible: true,
      eyebrow: "Permissions",
      title: "Screen Recording Permission Required",
      body: "Grant screen recording access to capture system audio and start recordings.",
      primaryLabel: "Grant Screen Access",
    });
    return;
  }

  if (nextState === "needs_mic_permission") {
    setAppStateOverlay({
      visible: true,
      eyebrow: "Permissions",
      title: "Microphone Permission Required",
      body: "Grant microphone access if you want Meetlify to capture your microphone input.",
      primaryLabel: "Grant Microphone Access",
      secondaryLabel: "Continue Without Mic",
    });
    return;
  }

  if (nextState === "recovering") {
    setAppStateOverlay({
      visible: true,
      eyebrow: "Recovery",
      title: "Recovering Session State",
      body: "Meetlify is reconciling recordings and background tasks from the previous session.",
    });
    return;
  }

  setAppStateOverlay({ visible: false });
};

const applyPermissionSummary = (permissions) => {
  appPermissions = permissions || appPermissions;
};

const shouldBlockSelectionHeavyLoad = (recording) => HEAVY_SELECTION_BLOCKED_STATUSES.has(recording?.status);

const formatQualityFlag = (flag) => {
  const lookup = {
    invalid_timestamp: "timestamps could not be parsed",
    timestamps_non_monotonic: "timestamps are out of order",
    missing_diarized_lines: "speaker diarization is missing",
    mixed_format_output: "output format is inconsistent",
    summary_like_output: "content reads like a summary instead of a transcript",
    coverage_too_low: "timestamps cover too little of the audio",
    coverage_too_high: "timestamps exceed the audio duration",
    density_too_high: "transcript density is implausibly high",
    density_too_low: "transcript density is implausibly low",
    too_few_transcript_segments: "too few transcript segments were detected",
  };

  return lookup[flag] || String(flag || "").replace(/_/gu, " ");
};

const updateReviewWarningState = (recording = getSelectedRecording()) => {
  const isNeedsReview = recording?.status === "needs_review";
  reviewWarningBannerEl.classList.toggle("hidden-panel", !isNeedsReview);

  if (!isNeedsReview) {
    return;
  }

  const flagSummary = Array.isArray(recording.qualityFlags) && recording.qualityFlags.length
    ? recording.qualityFlags.map(formatQualityFlag).join(", ")
    : "Gemini returned low-confidence transcript content.";
  reviewWarningTextEl.textContent = `Transcript needs review: ${flagSummary}. Verify it against the source audio before relying on it.`;
  reviewWarningRetryEl.disabled = !recording.canTranscribe || isStartingTranscription || isStoppingTranscription;
  reviewWarningRetryEl.classList.toggle("disabled-button", reviewWarningRetryEl.disabled);
  reviewWarningAcceptEl.disabled = !recording.canAcceptTranscript;
  reviewWarningAcceptEl.classList.toggle("disabled-button", reviewWarningAcceptEl.disabled);
};

const syncShellState = () => {
  if (!appPermissions?.screen?.granted) {
    updateShellState("needs_screen_permission");
    return;
  }

  if (selectedMicDeviceId && !appPermissions?.microphone?.granted) {
    updateShellState("needs_mic_permission");
    return;
  }

  updateShellState("setup");
};

const getSelectionReloadSignature = (recording) => {
  if (!recording) {
    return "";
  }

  return [
    recording.id,
    recording.status,
    recording.statusDetail || "",
    recording.transcriptPath || "",
    recording.mediaPath || "",
    recording.modifiedAt || "",
    recording.sizeBytes || 0,
    recording.lastError || "",
    Array.isArray(recording.qualityFlags) ? recording.qualityFlags.join(",") : "",
  ].join("|");
};

const shouldLoadSelectionDetails = ({ previousSelection, nextSelection, explicitLoadDetails } = {}) => {
  if (typeof explicitLoadDetails === "boolean") {
    return explicitLoadDetails;
  }

  if (!nextSelection || shouldBlockSelectionHeavyLoad(nextSelection)) {
    return false;
  }

  return getSelectionReloadSignature(previousSelection) !== getSelectionReloadSignature(nextSelection);
};

const closeMp3ExportModal = (selection = null) => {
  mp3ExportModalEl.classList.add("hidden-panel");
  if (pendingMp3ExportResolve) {
    pendingMp3ExportResolve(selection);
    pendingMp3ExportResolve = null;
  }
};

const askMp3ExportMode = () => new Promise((resolve) => {
  pendingMp3ExportResolve = resolve;
  mp3ExportModalEl.classList.remove("hidden-panel");
});

const closeRetranscribeModal = (selection = false) => {
  retranscribeModalEl.classList.add("hidden-panel");
  if (pendingRetranscribeResolve) {
    pendingRetranscribeResolve(selection);
    pendingRetranscribeResolve = null;
  }
};

const askRetranscribeOverride = () => new Promise((resolve) => {
  pendingRetranscribeResolve = resolve;
  retranscribeModalEl.classList.remove("hidden-panel");
});

const closeDeleteRecordingModal = (selection = false) => {
  deleteRecordingModalEl.classList.add("hidden-panel");
  if (pendingDeleteResolve) {
    pendingDeleteResolve(selection);
    pendingDeleteResolve = null;
  }
};

const askDeleteRecordingConfirm = (recordingLabel) => new Promise((resolve) => {
  pendingDeleteResolve = resolve;
  deleteRecordingNameEl.textContent = recordingLabel || "this item";
  deleteRecordingModalEl.classList.remove("hidden-panel");
});

const switchView = (view) => {
  const nextView = ["setup", "review", "prompt"].includes(view) ? view : "setup";
  if (nextView !== "prompt") {
    previousPrimaryView = nextView;
    persistAppSessionState();
  }
  currentView = nextView;
  setupViewEl.classList.toggle("hidden", nextView !== "setup");
  reviewViewEl.classList.toggle("hidden", nextView !== "review");
  promptViewEl.classList.toggle("hidden", nextView !== "prompt");
  renderStatusMessage();
};

const selectNewRecordingState = () => {
  selectionRequestId += 1;
  setSelectedRecordingId("");
  transcriptPath = null;
  selectedRecordingHasTranscript = false;
  reviewTitleEl.textContent = "Select a file";
  metaDateTimeEl.textContent = "-";
  metaSizeEl.textContent = "-";
  metaDurationStaticEl.textContent = "-";
  openTranscriptButtonEl.disabled = true;
  openTranscriptButtonEl.classList.add("disabled-button");
  resetPlayerSource();
  setEditorContent("", { resetHistory: true });
  saveBtnEl.disabled = true;
  saveBtnEl.classList.add("disabled-button");
  exportMp3El.disabled = true;
  exportMp3El.classList.add("disabled-button");
  recordingAnalysis = null;
  updateEstimateDisplay();
  setProcessButtonState({ isLoading: false });
  isEditingRecordingTitle = false;
  refreshDefaultRecordingFilename({ force: true });
  startRecordingFilenameClock();
  syncRecordingFilenameFieldState();
  syncDeleteButtonState();
  updateReviewWarningState(null);
  renderLibrary();
};

const updateEditorHeaderLayout = () => {
  if (!editorHeaderLayoutEl || !editorHeaderPrimaryEl || !editorHeaderToolsEl || !saveBtnEl) {
    return;
  }

  editorHeaderLayoutEl.classList.remove("editor-header-stacked");

  const containerWidth = editorHeaderLayoutEl.clientWidth;
  if (!containerWidth) return;

  const primaryWidth = Math.ceil(editorHeaderPrimaryEl.getBoundingClientRect().width);
  const toolsWidth = Math.ceil(editorHeaderToolsEl.scrollWidth);
  const saveWidth = Math.ceil(saveBtnEl.getBoundingClientRect().width);
  const buffer = 20;

  editorHeaderLayoutEl.classList.toggle(
    "editor-header-stacked",
    (primaryWidth + toolsWidth + saveWidth + buffer) > containerWidth
  );
};

const updateReviewTitleEditState = () => {
  const isEmpty = !reviewTitleEl.textContent.trim();
  reviewTitleEl.dataset.empty = isEmpty ? "true" : "false";
  reviewTitleEl.dataset.placeholder = "Session title";
};

const collapseSidebar = () => {
  sidebarPaneEl.style.display = "none";
  sidebarResizerEl.style.display = "none";
  sidebarRailEl.classList.remove("hidden-panel");
};

const restoreSidebar = () => {
  sidebarPaneEl.style.display = "flex";
  sidebarPaneEl.style.width = `${sidebarWidth}px`;
  sidebarResizerEl.style.display = "block";
  sidebarRailEl.classList.add("hidden-panel");
};

const getDefaultMeetingFilename = () => {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `Meeting_Recording-${dd}${mm}${yyyy}-${hh}${min}`;
};

const syncRecordingFilenameFieldState = () => {
  recordingFilenameEl.readOnly = !isEditingRecordingTitle;
  editRecordingFilenameEl.disabled = isPendingStart || isPendingStop;
  editRecordingFilenameEl.classList.toggle("disabled-button", isPendingStart || isPendingStop);
};

const setRecordingFilenameValue = (nextValue, { custom = false } = {}) => {
  recordingFilename = nextValue;
  recordingFilenameEl.value = nextValue;
  hasCustomRecordingFilename = custom;

  if (isRecording || isPendingStop) {
    ipcRenderer.send("update-recording-filename", {
      filename: recordingFilename,
    });
  }
};

const refreshDefaultRecordingFilename = ({ force = false } = {}) => {
  if (!force && (isRecording || isPendingStart || isPendingStop || isEditingRecordingTitle || hasCustomRecordingFilename)) {
    return;
  }

  const nextDefaultFilename = getDefaultMeetingFilename();
  if (force || recordingFilename !== nextDefaultFilename) {
    setRecordingFilenameValue(nextDefaultFilename, { custom: false });
  }
};

const startRecordingFilenameClock = () => {
  if (recordingFilenameClockTimer) return;
  recordingFilenameClockTimer = window.setInterval(() => {
    refreshDefaultRecordingFilename();
  }, 10000);
};

const stopRecordingFilenameClock = () => {
  if (!recordingFilenameClockTimer) return;
  window.clearInterval(recordingFilenameClockTimer);
  recordingFilenameClockTimer = null;
};

const stopEditingRecordingFilename = ({ restoreDefaultIfEmpty = true } = {}) => {
  isEditingRecordingTitle = false;
  const trimmedValue = recordingFilenameEl.value.trim();

  if (!trimmedValue && restoreDefaultIfEmpty) {
    refreshDefaultRecordingFilename({ force: true });
  } else {
    setRecordingFilenameValue(trimmedValue || recordingFilename, { custom: Boolean(trimmedValue) });
  }

  if (!recordingFilenameEl.value.trim()) {
    refreshDefaultRecordingFilename({ force: true });
  }

  syncRecordingFilenameFieldState();
};

const startEditingRecordingFilename = () => {
  if (isPendingStart || isPendingStop) return;
  isEditingRecordingTitle = true;
  syncRecordingFilenameFieldState();
  recordingFilenameEl.focus();
  recordingFilenameEl.select();
};

const formatRecordingClock = (seconds) => {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const secs = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
};

const formatDurationLabel = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00:00";
  return formatRecordingClock(seconds);
};

const formatSize = (sizeBytes) => {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "-";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatEuro = (value) => {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
};

const formatUsd = (value) => {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
};

const getSelectedRecording = () => recordings.find((recording) => recording.id === selectedRecordingId) || null;
const getRecordingByPath = (recordingPath) => recordings.find((recording) => recording.path === recordingPath || recording.mediaPath === recordingPath) || null;
const getRecordingById = (recordingId) => recordings.find((recording) => recording.id === recordingId) || null;
const isLatestSelectionRequest = (requestId) => requestId === selectionRequestId;
const normalizeRecordings = (items = []) => items.map((recording) => ({
  ...recording,
  id: recording.id || recording.path,
  displayName: recording.displayName || recording.name || "",
  name: recording.displayName || recording.name || "",
  status: recording.status || "ready",
  statusDetail: recording.statusDetail || "",
  qualityFlags: Array.isArray(recording.qualityFlags) ? recording.qualityFlags : [],
  lastTranscriptionModel: recording.lastTranscriptionModel || null,
  lastTranscriptionCompletedAt: recording.lastTranscriptionCompletedAt || null,
  isBusy: typeof recording.isBusy === "boolean" ? recording.isBusy : ["recording", "stopping", "finalizing", "importing", "transcribing"].includes(recording.status),
  hasUsableMedia: typeof recording.hasUsableMedia === "boolean" ? recording.hasUsableMedia : Boolean(recording.sizeBytes),
  canTranscribe: typeof recording.canTranscribe === "boolean" ? recording.canTranscribe : Boolean(recording.sizeBytes),
  canExport: typeof recording.canExport === "boolean" ? recording.canExport : Boolean(recording.sizeBytes),
  canOpen: typeof recording.canOpen === "boolean"
    ? recording.canOpen
    : (recording.status === "ready" || recording.status === "needs_review" || recording.status === "error" || recording.status === "transcribing"),
  isSelectable: typeof recording.isSelectable === "boolean"
    ? recording.isSelectable
    : (recording.status === "ready" || recording.status === "needs_review" || recording.status === "error"),
  canAcceptTranscript: recording.status === "needs_review",
}));

const getRecordingLabel = (recording) => recording?.displayName || recording?.name || "Meeting";

const formatLibraryStatus = (status) => {
  switch (status) {
    case "recording":
      return "Recording";
    case "stopping":
      return "Stopping";
    case "finalizing":
      return "Finalizing";
    case "importing":
      return "Importing";
    case "transcribing":
      return "Transcribing";
    case "needs_review":
      return "Needs review";
    case "error":
      return "Needs attention";
    default:
      return "Ready";
  }
};

const getLibraryStatusText = (recording) => {
  const baseStatus = formatLibraryStatus(recording?.status);
  return recording?.statusDetail ? `${baseStatus} · ${recording.statusDetail}` : baseStatus;
};

const setTheme = (theme) => {
  const resolvedTheme = theme === "system" ? (SYSTEM_THEME_QUERY.matches ? "dark" : "light") : theme;
  document.body.dataset.theme = resolvedTheme;
};

const syncTheme = () => {
  themeModeEl.value = themeMode;
  setTheme(themeMode);
};

const setSettingsOpen = async (isOpen, { persist = true } = {}) => {
  settingsPanelOpen = isOpen;
  settingsPanelEl.classList.toggle("hidden", !isOpen);
  settingsChevronEl.classList.toggle("rotate-180", !isOpen);

  if (persist) {
    await ipcRenderer.invoke("set-disclosure-state", {
      [DISCLOSURE_SETTINGS_PANEL]: isOpen,
    }).catch(() => {});
  }
};

const setGeminiApiKeyStatus = (settings) => {
  if (!settings?.hasApiKey) {
    geminiKeyStatusEl.textContent = "No Gemini API key saved yet.";
    return;
  }

  geminiKeyStatusEl.textContent = settings.source === "env"
    ? ""
    : `Gemini API key saved in app settings at ${settings.settingsPath}`;
};

const setAudioLevels = (systemLevel = 0, micLevel = 0) => {
  meterSystemEl.style.width = `${Math.max(0, Math.min(100, Math.round(systemLevel * 100)))}%`;
  meterMicEl.style.width = `${Math.max(0, Math.min(100, Math.round(micLevel * 100)))}%`;
};

const refreshDisplayedAudioLevels = () => {
  const systemLevel = isRecording ? recorderSystemLevel : 0;
  const micLevel = isRecording ? recorderMicLevel : liveMicLevel;
  setAudioLevels(systemLevel, micLevel);
};

const setSidebarRecordingActionState = ({ recording = false, pending = false } = {}) => {
  if (recording) {
    sidebarNewRecordingEl.disabled = false;
    sidebarRailNewRecordingEl.disabled = false;
    sidebarNewRecordingEl.style.backgroundColor = "#dc2626";
    sidebarNewRecordingEl.style.color = "white";
    sidebarNewRecordingEl.innerHTML = "RECORDING IN PROGRESS";
    sidebarRailNewRecordingEl.style.backgroundColor = "#dc2626";
    sidebarRailNewRecordingEl.style.borderColor = "#dc2626";
    sidebarRailNewRecordingEl.style.color = "white";
    sidebarRailNewRecordingEl.innerHTML = '<i data-lucide="mic" class="w-4 h-4"></i>';
    sidebarNewRecordingEl.title = "Return to recording";
    sidebarRailNewRecordingEl.title = "Return to recording";
    sidebarNewRecordingEl.classList.toggle("opacity-60", pending);
    sidebarRailNewRecordingEl.classList.toggle("opacity-60", pending);
    renderIcons();
    return;
  }

  sidebarNewRecordingEl.disabled = false;
  sidebarRailNewRecordingEl.disabled = false;
  sidebarNewRecordingEl.style.backgroundColor = "#2563eb";
  sidebarNewRecordingEl.style.color = "white";
  sidebarNewRecordingEl.innerHTML = `
    <i data-lucide="plus" class="w-4 h-4"></i>
    NEW RECORDING
  `;
  sidebarRailNewRecordingEl.style.backgroundColor = "#2563eb";
  sidebarRailNewRecordingEl.style.borderColor = "#2563eb";
  sidebarRailNewRecordingEl.style.color = "white";
  sidebarRailNewRecordingEl.innerHTML = '<i data-lucide="plus" class="w-4 h-4"></i>';
  sidebarNewRecordingEl.title = "New recording";
  sidebarRailNewRecordingEl.title = "New recording";
  sidebarNewRecordingEl.classList.remove("opacity-60");
  sidebarRailNewRecordingEl.classList.remove("opacity-60");
  renderIcons();
};

const setRecordingButtonState = () => {
  recordButtonEl.classList.remove("opacity-60");

  const setIdleButton = () => {
    recordButtonEl.style.background = "var(--button-main)";
    recordButtonEl.style.border = "1px solid var(--border-main)";
    recordButtonEl.style.color = "var(--text-soft)";
    recordIconEl.innerHTML = '<i data-lucide="mic" class="w-8 h-8 transition-transform group-active:scale-90"></i>';
    setSidebarRecordingActionState({ recording: false });
    renderIcons();
  };

  const setRecordingButton = ({ pending = false } = {}) => {
    recordButtonEl.style.background = "#dc2626";
    recordButtonEl.style.border = "1px solid #dc2626";
    recordButtonEl.style.color = "white";
    if (pending) {
      recordButtonEl.classList.add("opacity-60");
    }
    recordIconEl.innerHTML = '<div class="w-6 h-6 rounded-sm bg-white transition-transform group-active:scale-90"></div>';
    setSidebarRecordingActionState({ recording: true, pending });
  };

  if (isPendingStart) {
    setIdleButton();
    recordButtonEl.classList.add("opacity-60");
    return;
  }

  if (isPendingStop) {
    setRecordingButton({ pending: true });
    return;
  }

  if (isRecording) {
    setRecordingButton();
    return;
  }

  setIdleButton();
  syncRecordingFilenameFieldState();
};

const setProcessButtonState = ({ isLoading = false } = {}) => {
  const selected = getSelectedRecording();
  const isTranscribing = selected?.status === "transcribing";
  const isDisabled = !selected
    || !selected.canOpen
    || (isTranscribing ? isStoppingTranscription : (isLoading || isStartingTranscription || !selected.canTranscribe));

  processButtonEl.disabled = isDisabled;
  processButtonEl.classList.toggle("btn-processing-loading", isLoading || isStartingTranscription || isStoppingTranscription);
  processButtonEl.classList.toggle("disabled-button", isDisabled);

  if (isTranscribing) {
    processButtonTextEl.innerHTML = isStoppingTranscription
      ? 'STOPPING <span class="loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>'
      : 'STOP TRANSCRIBING';
    return;
  }

  if (isLoading || isStartingTranscription) {
    processButtonTextEl.innerHTML = 'TRANSCRIBING <span class="loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
    return;
  }

  processButtonTextEl.textContent = selectedRecordingHasTranscript ? "RETRANSCRIBE" : "TRANSCRIBE";
  updateReviewWarningState(selected);
};

const syncDeleteButtonState = () => {
  const selected = getSelectedRecording();
  const isActiveRecording = Boolean(selected && currentRecordingId === selected.id && (isRecording || isPendingStart || isPendingStop));
  const isDisabled = !selected
    || !selected.canOpen
    || isActiveRecording
    || BUSY_RECORDING_STATUSES.has(selected.status);

  deleteRecordingEl.disabled = isDisabled;
  deleteRecordingEl.classList.toggle("disabled-button", isDisabled);
};

const startElapsedTimer = (timestamp) => {
  clearTimeout(updateTimer);
  startTimeMs = Number.isFinite(timestamp) ? timestamp : Date.now();

  const tick = () => {
    if (startTimeMs === null) return;
    const elapsedTime = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000));
    timerDisplayEl.textContent = formatRecordingClock(elapsedTime);
    currentTimeEl.textContent = formatRecordingClock(Math.min(elapsedTime, recordingPlayerEl.currentTime || elapsedTime));
    updateTimer = setTimeout(tick, 1000);
  };

  tick();
};

const stopElapsedTimer = (timestamp) => {
  clearTimeout(updateTimer);
  updateTimer = null;
  if (startTimeMs !== null) {
    const endTimeMs = Number.isFinite(timestamp) ? timestamp : Date.now();
    const elapsedTime = Math.max(0, Math.floor((endTimeMs - startTimeMs) / 1000));
    timerDisplayEl.textContent = formatRecordingClock(elapsedTime);
  } else {
    timerDisplayEl.textContent = "00:00:00";
  }
  startTimeMs = null;
};

const freezeElapsedTimer = () => {
  clearTimeout(updateTimer);
  updateTimer = null;
  if (startTimeMs !== null) {
    const elapsedTime = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000));
    timerDisplayEl.textContent = formatRecordingClock(elapsedTime);
  }
};

const resetRecordingUiState = (timestamp) => {
  isRecording = false;
  isPendingStart = false;
  isPendingStop = false;
  setRecordingButtonState();
  stopElapsedTimer(timestamp);
  recorderSystemLevel = 0;
  recorderMicLevel = 0;
  microphoneSelectEl.disabled = false;
  startRecordingFilenameClock();
  refreshDisplayedAudioLevels();
  syncDeleteButtonState();
};

const renderPreview = () => {
  const markdown = markdownEditorEl.value || "";
  try {
    previewContentEl.innerHTML = markdown.trim() ? markdownParser.render(markdown) : "";
  } catch (error) {
    previewContentEl.textContent = `Preview rendering failed: ${error.message}`;
  }
};

const updateHistoryButtons = () => {
  undoBtnEl.disabled = !editorHistory.undoStack.length;
  redoBtnEl.disabled = !editorHistory.redoStack.length;
  undoBtnEl.classList.toggle("disabled-button", !editorHistory.undoStack.length);
  redoBtnEl.classList.toggle("disabled-button", !editorHistory.redoStack.length);
};

const syncHistoryFromEditor = (nextValue, { reset = false } = {}) => {
  if (reset) {
    editorHistory = {
      undoStack: [],
      redoStack: [],
      currentValue: nextValue,
    };
    updateHistoryButtons();
    return;
  }

  if (nextValue === editorHistory.currentValue) {
    updateHistoryButtons();
    return;
  }

  editorHistory.undoStack.push(editorHistory.currentValue);
  if (editorHistory.undoStack.length > HISTORY_LIMIT) {
    editorHistory.undoStack.splice(0, editorHistory.undoStack.length - HISTORY_LIMIT);
  }
  editorHistory.redoStack = [];
  editorHistory.currentValue = nextValue;
  updateHistoryButtons();
};

const setEditorContent = (nextValue, { resetHistory = false } = {}) => {
  isApplyingHistory = true;
  markdownEditorEl.value = nextValue;
  renderPreview();
  updateSearchMatches({ focusEditor: false });
  syncHistoryFromEditor(nextValue, { reset: resetHistory });
  populateSpeakerDropdown(nextValue);
  isApplyingHistory = false;
};

const applyHistoryValue = (nextValue) => {
  isApplyingHistory = true;
  markdownEditorEl.value = nextValue;
  editorHistory.currentValue = nextValue;
  renderPreview();
  updateSearchMatches({ focusEditor: false });
  populateSpeakerDropdown(nextValue);
  updateHistoryButtons();
  isApplyingHistory = false;
};

const undoEditor = () => {
  if (!editorHistory.undoStack.length) return;
  editorHistory.redoStack.push(editorHistory.currentValue);
  applyHistoryValue(editorHistory.undoStack.pop());
};

const redoEditor = () => {
  if (!editorHistory.redoStack.length) return;
  editorHistory.undoStack.push(editorHistory.currentValue);
  applyHistoryValue(editorHistory.redoStack.pop());
};

const updatePromptHistoryButtons = () => {
  promptUndoBtnEl.disabled = !promptHistory.undoStack.length;
  promptRedoBtnEl.disabled = !promptHistory.redoStack.length;
  promptUndoBtnEl.classList.toggle("disabled-button", !promptHistory.undoStack.length);
  promptRedoBtnEl.classList.toggle("disabled-button", !promptHistory.redoStack.length);
};

const syncHistoryFromPrompt = (nextValue, { reset = false } = {}) => {
  if (reset) {
    promptHistory = {
      undoStack: [],
      redoStack: [],
      currentValue: nextValue,
    };
    updatePromptHistoryButtons();
    return;
  }

  if (nextValue === promptHistory.currentValue) {
    updatePromptHistoryButtons();
    return;
  }

  promptHistory.undoStack.push(promptHistory.currentValue);
  if (promptHistory.undoStack.length > HISTORY_LIMIT) {
    promptHistory.undoStack.splice(0, promptHistory.undoStack.length - HISTORY_LIMIT);
  }
  promptHistory.redoStack = [];
  promptHistory.currentValue = nextValue;
  updatePromptHistoryButtons();
};

const setPromptContent = (nextValue, { resetHistory = false } = {}) => {
  isApplyingPromptHistory = true;
  transcriptionPromptEl.value = nextValue;
  syncHistoryFromPrompt(nextValue, { reset: resetHistory });
  isApplyingPromptHistory = false;
};

const applyPromptHistoryValue = (nextValue) => {
  isApplyingPromptHistory = true;
  transcriptionPromptEl.value = nextValue;
  promptHistory.currentValue = nextValue;
  updatePromptHistoryButtons();
  isApplyingPromptHistory = false;
};

const undoPrompt = () => {
  if (!promptHistory.undoStack.length) return;
  promptHistory.redoStack.push(promptHistory.currentValue);
  applyPromptHistoryValue(promptHistory.undoStack.pop());
};

const redoPrompt = () => {
  if (!promptHistory.redoStack.length) return;
  promptHistory.undoStack.push(promptHistory.currentValue);
  applyPromptHistoryValue(promptHistory.redoStack.pop());
};

const captureTextSelection = (element) => {
  if (!element) return null;
  return {
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection || "none",
  };
};

const restoreTextSelection = (element, selection) => {
  if (!element) return;
  element.focus({ preventScroll: true });
  if (!selection) return;
  try {
    element.setSelectionRange(selection.start, selection.end, selection.direction);
  } catch {
    // Ignore selection restore failures on detached or disabled elements.
  }
};

const updateSearchStatus = () => {
  if (!findInputEl.value) {
    searchStatusEl.textContent = "Search term required";
    return;
  }
  if (!searchMatches.length) {
    searchStatusEl.textContent = "No matches";
    return;
  }
  const current = activeSearchIndex >= 0 ? activeSearchIndex + 1 : 0;
  searchStatusEl.textContent = `${current}/${searchMatches.length} matches`;
};

const scrollEditorMatchIntoView = (match) => {
  if (!match) {
    return;
  }

  const textBeforeMatch = markdownEditorEl.value.slice(0, match.start);
  const lineIndex = textBeforeMatch.split("\n").length - 1;
  const columnIndex = textBeforeMatch.length - (textBeforeMatch.lastIndexOf("\n") + 1);
  const computedStyle = window.getComputedStyle(markdownEditorEl);
  const fontSize = parseFloat(computedStyle.fontSize) || 14;
  const lineHeight = parseFloat(computedStyle.lineHeight) || (fontSize * 1.5);
  const estimatedCharWidth = fontSize * 0.62;
  const nextScrollTop = Math.max(0, (lineIndex * lineHeight) - ((markdownEditorEl.clientHeight - lineHeight) / 2));
  const nextScrollLeft = Math.max(0, (columnIndex * estimatedCharWidth) - (markdownEditorEl.clientWidth / 3));

  markdownEditorEl.scrollTop = nextScrollTop;
  markdownEditorEl.scrollLeft = nextScrollLeft;
};

const selectMatchByIndex = (index, { focusEditor = true } = {}) => {
  if (!searchMatches.length) {
    activeSearchIndex = -1;
    updateSearchStatus();
    return;
  }
  const normalized = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
  activeSearchIndex = normalized;
  const match = searchMatches[normalized];
  if (focusEditor) {
    markdownEditorEl.focus();
  }
  markdownEditorEl.setSelectionRange(match.start, match.end);
  requestAnimationFrame(() => {
    scrollEditorMatchIntoView(match);
  });
  updateSearchStatus();
};

const updateSearchMatches = ({ focusEditor = true } = {}) => {
  const term = findInputEl.value;
  const text = markdownEditorEl.value;
  searchMatches = [];
  activeSearchIndex = -1;

  if (!term) {
    updateSearchStatus();
    return;
  }

  const lookup = term.toLowerCase();
  const source = text.toLowerCase();
  let from = 0;
  while (true) {
    const foundIndex = source.indexOf(lookup, from);
    if (foundIndex === -1) break;
    searchMatches.push({
      start: foundIndex,
      end: foundIndex + term.length,
    });
    from = foundIndex + term.length;
  }

  if (searchMatches.length) {
    selectMatchByIndex(0, { focusEditor });
  } else {
    updateSearchStatus();
  }
};

const replaceCurrentMatch = () => {
  if (!findInputEl.value) {
    updateSearchStatus();
    return;
  }
  if (!searchMatches.length) {
    updateSearchMatches();
    return;
  }
  if (activeSearchIndex < 0) {
    selectMatchByIndex(0);
    return;
  }
  const replacement = replaceInputEl.value;
  const text = markdownEditorEl.value;
  const match = searchMatches[activeSearchIndex];
  setEditorContent(`${text.slice(0, match.start)}${replacement}${text.slice(match.end)}`);
  if (searchMatches.length) {
    selectMatchByIndex(Math.min(activeSearchIndex, searchMatches.length - 1));
  }
};

const replaceAllMatches = () => {
  const term = findInputEl.value;
  if (!term) {
    updateSearchStatus();
    return;
  }
  const replacement = replaceInputEl.value;
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escapedTerm, "gi");
  setEditorContent(markdownEditorEl.value.replace(regex, replacement));
};

const populateSpeakerDropdown = (markdown = markdownEditorEl.value) => {
  const currentValue = speakerDropdownEl.value;
  const detectedMatches = Array.from(new Set(Array.from(markdown.matchAll(/Speaker\s+\d+/g)).map((match) => match[0])));
  const defaultSpeakers = Array.from({ length: 5 }, (_, index) => `Speaker ${index + 1}`);
  const matches = Array.from(new Set([...defaultSpeakers, ...detectedMatches]));
  speakerDropdownEl.innerHTML = '<option value="">Choose speaker...</option>';
  matches.forEach((speaker) => {
    const option = document.createElement("option");
    option.value = speaker;
    option.textContent = speaker;
    speakerDropdownEl.appendChild(option);
  });
  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "Custom...";
  speakerDropdownEl.appendChild(customOption);
  speakerDropdownEl.value = Array.from(speakerDropdownEl.options).some((option) => option.value === currentValue) ? currentValue : "";
};

const renderLibrary = () => {
  recordingsListEl.innerHTML = "";

  if (!recordings.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "text-[11px] italic px-2 py-3";
    emptyState.style.color = "var(--text-soft)";
    emptyState.textContent = "No recordings found.";
    recordingsListEl.appendChild(emptyState);
    return;
  }

  recordings.forEach((recording) => {
    const item = document.createElement("button");
    item.type = "button";
    const isPending = !recording.canOpen;
    const isBusy = Boolean(recording.isBusy);
    const isError = recording.status === "error";
    const isNeedsReview = recording.status === "needs_review";
    item.disabled = isPending;
    item.className = `sidebar-item w-full p-2 rounded-lg flex flex-col text-left ${selectedRecordingId === recording.id ? "active" : ""} ${isBusy ? "pending" : ""} ${recording.canOpen ? "cursor-pointer" : ""} ${isError ? "error" : ""} ${isNeedsReview ? "error" : ""}`;
    const statusIcon = isBusy
      ? '<i data-lucide="loader-2" class="w-3 h-3 animate-spin-fast"></i>'
      : (isNeedsReview
        ? '<i data-lucide="shield-alert" class="w-3 h-3"></i>'
        : (isError ? '<i data-lucide="triangle-alert" class="w-3 h-3"></i>' : ""));
    item.innerHTML = `
      <span class="text-xs font-semibold truncate">${getRecordingLabel(recording)}</span>
      <span class="text-[9px]" style="color: var(--text-soft);">${new Date(recording.createdAt).toLocaleString()}</span>
      <span class="text-[9px] flex items-center gap-1 mt-1" style="color: ${isError ? "#f87171" : (isNeedsReview ? "#fbbf24" : "var(--text-soft)")};">${statusIcon}<span>${getLibraryStatusText(recording)}</span></span>
    `;
    if (recording.canOpen) {
      item.addEventListener("click", async () => {
        setSelectedRecordingId(recording.id);
        renderLibrary();
        const requestId = ++selectionRequestId;
        await updateSelection({ switchToReview: true, requestId });
      });
    }
    recordingsListEl.appendChild(item);
  });

  renderIcons();
};

const updateSelectedModelDescription = () => {
  const selectedModel = modelCatalog.find((model) => model.id === modelSelectEl.value);
  if (modelDescriptionEl) {
    modelDescriptionEl.textContent = selectedModel?.description || "";
  }
};

const updateEstimateDisplay = () => {
  if (!recordingAnalysis?.estimate) {
    costEstimateEl.textContent = "€0.000";
    if (recordingAnalysisEl) recordingAnalysisEl.textContent = "";
    if (costEstimateDetailEl) costEstimateDetailEl.textContent = "";
    metaDurationStaticEl.textContent = "-";
    return;
  }

  const { estimate, exchangeRate, durationSeconds, sizeBytes } = recordingAnalysis;
  costEstimateEl.textContent = estimate.estimatedEur !== null ? formatEuro(estimate.estimatedEur) : formatUsd(estimate.estimatedUsd);
  metaDurationStaticEl.textContent = formatDurationLabel(durationSeconds);
};

const refreshRecordingAnalysis = async () => {
  const selected = getSelectedRecording();
  if (!selected || !selected.hasUsableMedia) {
    recordingAnalysis = null;
    updateEstimateDisplay();
    return;
  }

  try {
    if (shouldBlockSelectionHeavyLoad(selected)) {
      recordingAnalysis = {
        path: selected.path,
        sizeBytes: selected.sizeBytes,
        durationSeconds: selected.durationSeconds,
        estimate: null,
      };
      updateEstimateDisplay();
      return;
    }
    recordingAnalysis = await ipcRenderer.invoke("get-recording-analysis", {
      recordingId: selected.id,
      model: modelSelectEl.value,
    });
  } catch (error) {
    recordingAnalysis = null;
    if (costEstimateDetailEl) costEstimateDetailEl.textContent = error.message;
  }

  updateEstimateDisplay();
};

const setPlayerButtonIcon = (iconName) => {
  playerToggleIconEl.setAttribute("data-lucide", iconName);
  renderIcons();
};

const setPlaybackControlsState = ({ enabled, loading = false } = {}) => {
  isPlaybackLoading = loading;
  playerToggleEl.disabled = !enabled;
  playerSeekEl.disabled = !enabled;
  playerToggleEl.classList.toggle("disabled-button", !enabled);
  playerSeekEl.classList.toggle("disabled-button", !enabled);
  setPlayerButtonIcon(loading ? "loader-2" : (recordingPlayerEl.paused ? "play" : "pause"));
  if (loading) {
    playerToggleIconEl.classList.add("animate-spin-fast");
  } else {
    playerToggleIconEl.classList.remove("animate-spin-fast");
  }
};

const resetPlayerSource = () => {
  recordingPlayerEl.pause();
  try {
    recordingPlayerEl.currentTime = 0;
  } catch {
    // Ignore reset failures for unloaded media.
  }
  recordingPlayerEl.removeAttribute("src");
  recordingPlayerEl.load();
  currentTimeEl.textContent = "00:00:00";
  playerDurationLabelEl.textContent = "00:00:00";
  playerProgressEl.style.width = "0%";
  setPlaybackControlsState({ enabled: false, loading: false });
};

const stopPlayback = ({ resetPosition = true } = {}) => {
  recordingPlayerEl.pause();
  if (resetPosition) {
    try {
      recordingPlayerEl.currentTime = 0;
    } catch {
      // Ignore reset failures for unloaded media.
    }
  }
  updatePlayerUi();
};

const updatePlayerUi = () => {
  const currentTime = Number.isFinite(recordingPlayerEl.currentTime) ? recordingPlayerEl.currentTime : 0;
  const duration = Number.isFinite(recordingPlayerEl.duration) ? recordingPlayerEl.duration : 0;
  currentTimeEl.textContent = formatRecordingClock(currentTime);
  playerDurationLabelEl.textContent = duration > 0 ? formatRecordingClock(duration) : "00:00:00";
  playerProgressEl.style.width = duration > 0 ? `${Math.min(100, (currentTime / duration) * 100)}%` : "0%";
  if (!isPlaybackLoading) {
    setPlayerButtonIcon(recordingPlayerEl.paused ? "play" : "pause");
  }
};

const updateSelection = async ({ switchToReview = false, requestId = selectionRequestId, loadDetails = true } = {}) => {
  const selected = getSelectedRecording();
  if (!selected) {
    transcriptPath = null;
    selectedRecordingHasTranscript = false;
    reviewTitleEl.textContent = "Select a file";
    metaDateTimeEl.textContent = "-";
    metaSizeEl.textContent = "-";
    metaDurationStaticEl.textContent = "-";
    openTranscriptButtonEl.disabled = true;
    openTranscriptButtonEl.classList.add("disabled-button");
    resetPlayerSource();
    setEditorContent("", { resetHistory: true });
    saveBtnEl.disabled = true;
    saveBtnEl.classList.add("disabled-button");
    exportMp3El.disabled = true;
    exportMp3El.classList.add("disabled-button");
    recordingAnalysis = null;
    updateEstimateDisplay();
    setProcessButtonState({ isLoading: false });
    syncDeleteButtonState();
    updateReviewWarningState(null);
    if (!isRecording) {
      switchView("setup");
    }
    return;
  }

  persistAppSessionState();
  reviewTitleEl.textContent = getRecordingLabel(selected);
  metaDateTimeEl.textContent = new Date(selected.createdAt).toLocaleString();
  metaSizeEl.textContent = formatSize(selected.sizeBytes);
  const isBusySelection = BUSY_RECORDING_STATUSES.has(selected.status);
  const isTranscribingSelection = selected.status === "transcribing";
  const canExportNow = Boolean(selected.canExport && !isBusySelection);
  exportMp3El.disabled = !canExportNow;
  exportMp3El.classList.toggle("disabled-button", !canExportNow);
  markdownEditorEl.readOnly = isTranscribingSelection;
  updateReviewWarningState(selected);
  setProcessButtonState({ isLoading: false });
  syncDeleteButtonState();

  if (!loadDetails) {
    if (selected.statusDetail) {
      setStatusMessage(selected.statusDetail);
    }
    if (switchToReview) {
      switchView("review");
    }
    return;
  }

  transcriptPath = selected.transcriptPath || null;
  selectedRecordingHasTranscript = false;
  openTranscriptButtonEl.disabled = true;
  openTranscriptButtonEl.classList.add("disabled-button");
  saveBtnEl.disabled = true;
  saveBtnEl.classList.add("disabled-button");

  if (transcriptPath) {
    try {
      const result = await ipcRenderer.invoke("load-markdown", transcriptPath);
      if (!isLatestSelectionRequest(requestId)) return;
      setEditorContent(result.content || "", { resetHistory: true });
      selectedRecordingHasTranscript = true;
      openTranscriptButtonEl.disabled = false;
      openTranscriptButtonEl.classList.remove("disabled-button");
      saveBtnEl.disabled = isTranscribingSelection;
      saveBtnEl.classList.toggle("disabled-button", isTranscribingSelection);
    } catch {
      if (!isLatestSelectionRequest(requestId)) return;
      setEditorContent("", { resetHistory: true });
    }
  } else if (!selected.canOpen || isBusySelection) {
    setEditorContent("", { resetHistory: true });
  } else {
    setEditorContent("", { resetHistory: true });
  }

  if (!isLatestSelectionRequest(requestId)) return;

  if (!selected.canOpen && !isBusySelection) {
    resetPlayerSource();
    recordingAnalysis = null;
    updateEstimateDisplay();
    setStatusMessage(selected.lastError || "This item cannot be opened yet.");
    if (switchToReview) {
      switchView("review");
    }
    return;
  }

  if (selected.hasUsableMedia && !shouldBlockSelectionHeavyLoad(selected)) {
    await refreshRecordingAnalysis();
    if (!isLatestSelectionRequest(requestId)) return;

    try {
      resetPlayerSource();
      setPlaybackControlsState({ enabled: false, loading: true });
      const { playbackPath } = await ipcRenderer.invoke("get-playback-source", {
        recordingId: selected.id,
      });
      if (!isLatestSelectionRequest(requestId)) return;
      recordingPlayerEl.src = pathToFileURL(playbackPath).href;
      recordingPlayerEl.load();
    } catch (error) {
      if (!isLatestSelectionRequest(requestId)) return;
      resetPlayerSource();
      setStatusMessage(`Playback preparation failed: ${error.message}`);
    }
  } else {
    recordingAnalysis = null;
    updateEstimateDisplay();
    resetPlayerSource();
  }

  if (selected.status === "needs_review") {
    setStatusMessage(selected.statusDetail || "Transcript needs review before you rely on it.");
  } else if (isTranscribingSelection) {
    setStatusMessage(selected.statusDetail || "Transcription in progress.");
  } else if (selectedRecordingHasTranscript) {
    setStatusMessage(`Loaded transcript for ${getRecordingLabel(selected)}`);
  } else if (selected.lastError) {
    setStatusMessage(selected.lastError);
  } else if (selected.statusDetail) {
    setStatusMessage(selected.statusDetail);
  } else {
    setStatusMessage("No transcript yet for selected recording.");
  }

  if (switchToReview) {
    switchView("review");
  }
};

const applyRecordingsSnapshot = async (
  items = [],
  {
    switchToReview = false,
    autoSelectFirst = true,
    loadDetails,
    preferredRecordingId = "",
  } = {}
) => {
  const previousSelection = getSelectedRecording();
  recordings = normalizeRecordings(items);

  if (!recordings.some((recording) => recording.id === selectedRecordingId)) {
    const preferredRecording = getRecordingById(preferredRecordingId)
      || (currentRecordingId ? getRecordingById(currentRecordingId) : null);
    setSelectedRecordingId(preferredRecording?.id || (autoSelectFirst ? (recordings[0]?.id || "") : ""), {
      persist: false,
    });
  }

  renderLibrary();

  const nextSelection = getSelectedRecording();
  const shouldLoadDetailsNow = shouldLoadSelectionDetails({
    previousSelection,
    nextSelection,
    explicitLoadDetails: loadDetails,
  });

  const requestId = ++selectionRequestId;
  await updateSelection({
    switchToReview,
    requestId,
    loadDetails: shouldLoadDetailsNow,
  });
};

const refreshRecordings = ({ switchToReview = false, autoSelectFirst = true, loadDetails, preferredRecordingId = "" } = {}) => {
  refreshRecordingsPromise = refreshRecordingsPromise
    .catch(() => {})
    .then(async () => {
      const items = await ipcRenderer.invoke("list-recordings");
      await applyRecordingsSnapshot(items, {
        switchToReview,
        autoSelectFirst,
        loadDetails,
        preferredRecordingId,
      });
    })
    .catch((error) => {
      setStatusMessage(`Failed to load recordings: ${error.message}`);
    });

  return refreshRecordingsPromise;
};

const scheduleRefreshRecordings = (options = {}) => new Promise((resolve) => {
  if (refreshRecordingsTimer) {
    clearTimeout(refreshRecordingsTimer);
  }

  refreshRecordingsTimer = window.setTimeout(() => {
    refreshRecordingsTimer = null;
    refreshRecordings(options).finally(resolve);
  }, 120);
});

const requestRendererMicrophoneAccess = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This build cannot request microphone access from the renderer.");
  }

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
};

const AudioContextClass = window.AudioContext || window.webkitAudioContext;

const stopLiveMicMonitor = async () => {
  if (liveMonitorFrame) {
    cancelAnimationFrame(liveMonitorFrame);
    liveMonitorFrame = null;
  }
  liveMonitorAnalyser = null;
  liveMonitorData = null;

  if (liveMonitorStream) {
    liveMonitorStream.getTracks().forEach((track) => track.stop());
    liveMonitorStream = null;
  }

  if (liveMonitorAudioContext) {
    try {
      await liveMonitorAudioContext.close();
    } catch {
      // Ignore cleanup failures.
    }
    liveMonitorAudioContext = null;
  }

  liveMicLevel = 0;
  refreshDisplayedAudioLevels();
};

const readLiveMicLevel = () => {
  if (!liveMonitorAnalyser || !liveMonitorData) {
    liveMicLevel = 0;
    refreshDisplayedAudioLevels();
    return;
  }

  liveMonitorAnalyser.getFloatTimeDomainData(liveMonitorData);
  let sumSquares = 0;
  for (const sample of liveMonitorData) {
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / liveMonitorData.length);
  liveMicLevel = Math.max(0, Math.min(1, rms * 4));
  refreshDisplayedAudioLevels();
  liveMonitorFrame = requestAnimationFrame(readLiveMicLevel);
};

const startLiveMicMonitor = async (rendererDeviceId = "") => {
  await stopLiveMicMonitor();

  if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass) {
    return;
  }

  try {
    const constraints = rendererDeviceId
      ? { audio: { deviceId: { exact: rendererDeviceId } } }
      : { audio: true };

    liveMonitorStream = await navigator.mediaDevices.getUserMedia(constraints);
    liveMonitorAudioContext = new AudioContextClass();
    const source = liveMonitorAudioContext.createMediaStreamSource(liveMonitorStream);
    liveMonitorAnalyser = liveMonitorAudioContext.createAnalyser();
    liveMonitorAnalyser.fftSize = 2048;
    liveMonitorData = new Float32Array(liveMonitorAnalyser.fftSize);
    source.connect(liveMonitorAnalyser);
    readLiveMicLevel();
  } catch {
    liveMicLevel = 0;
    refreshDisplayedAudioLevels();
  }
};

const refreshMicrophones = async () => {
  try {
    const devices = await ipcRenderer.invoke("list-input-devices");
    microphoneSelectEl.innerHTML = '<option value="">No microphone</option>';

    devices.forEach((device) => {
      const option = document.createElement("option");
      option.value = device.id;
      option.dataset.rendererDeviceId = device.rendererDeviceId || "";
      option.textContent = device.isDefault ? `${device.name} (Default)` : device.name;
      microphoneSelectEl.appendChild(option);
    });

    if (selectedMicDeviceId && devices.some((device) => device.id === selectedMicDeviceId)) {
      microphoneSelectEl.value = selectedMicDeviceId;
    } else {
      const defaultDevice = devices.find((device) => device.isDefault);
      selectedMicDeviceId = defaultDevice?.id || "";
      microphoneSelectEl.value = selectedMicDeviceId;
    }

    selectedRendererMicDeviceId = microphoneSelectEl.selectedOptions[0]?.dataset.rendererDeviceId || "";
    await startLiveMicMonitor(selectedRendererMicDeviceId);
  } catch (error) {
    microphoneSelectEl.innerHTML = '<option value="">No microphone</option>';
    selectedMicDeviceId = "";
    selectedRendererMicDeviceId = "";
    await stopLiveMicMonitor();
    setStatusMessage(`Failed to load microphones: ${error.message}`);
  }
};

const loadAvailableMicrophonesIfGranted = async () => {
  const permissionState = await ipcRenderer.invoke("get-microphone-permission-status");
  if (permissionState?.status === "granted") {
    await refreshMicrophones();
  } else {
    microphoneSelectEl.innerHTML = '<option value="">No microphone</option>';
  }
};

const loadTranscriptionModels = async () => {
  const result = await ipcRenderer.invoke("get-transcription-models");
  modelCatalog = Array.isArray(result?.models) ? result.models : [];
  defaultTranscriptionModelId = result?.defaultModelId || modelCatalog[0]?.id || "";
  modelSelectEl.innerHTML = "";

  modelCatalog.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    modelSelectEl.appendChild(option);
  });

  if (defaultTranscriptionModelId && modelCatalog.some((model) => model.id === defaultTranscriptionModelId)) {
    modelSelectEl.value = defaultTranscriptionModelId;
  } else if (modelCatalog[0]) {
    modelSelectEl.value = modelCatalog[0].id;
  }

  updateSelectedModelDescription();
};

const applyRecordingStateSnapshot = (state) => {
  if (!state?.isRecording) {
    currentRecordingId = "";
    resetRecordingUiState(Date.now());
    return;
  }

  stopRecordingFilenameClock();
  currentRecordingId = state.recordingId || currentRecordingId;
  if (currentRecordingId) {
    setSelectedRecordingId(currentRecordingId, { persist: false });
  }
  isRecording = true;
  isPendingStart = false;
  isPendingStop = false;
  isEditingRecordingTitle = false;
  if (state.recordingName) {
    setRecordingFilenameValue(path.basename(state.recordingName, path.extname(state.recordingName)), { custom: true });
  }
  setRecordingButtonState();
  startElapsedTimer(state.startedAtMs);
  microphoneSelectEl.disabled = true;
  outputFilePathEl.textContent = state.recordingPath || "Recording in progress";
  syncDeleteButtonState();
  switchView("setup");
};

const collapsePane = (pane) => {
  if (pane === "editor") {
    editorPaneEl.style.display = "none";
    editorRailEl.classList.remove("hidden");
    resizerEl.style.display = "none";
    if (previewPaneEl.style.display !== "none") previewPaneEl.style.flex = "1 1 100%";
    return;
  }

  previewPaneEl.style.display = "none";
  previewRailEl.classList.remove("hidden");
  resizerEl.style.display = "none";
  if (editorPaneEl.style.display !== "none") editorPaneEl.style.flex = "1 1 100%";
};

const restorePane = (pane) => {
  if (pane === "editor") {
    editorPaneEl.style.display = "flex";
    editorRailEl.classList.add("hidden");
    if (previewPaneEl.style.display !== "none") {
      editorPaneEl.style.flex = `1 1 ${lastSplit}%`;
      previewPaneEl.style.flex = `1 1 ${100 - lastSplit}%`;
      resizerEl.style.display = "block";
    } else {
      editorPaneEl.style.flex = "1 1 100%";
    }
    return;
  }

  previewPaneEl.style.display = "flex";
  previewRailEl.classList.add("hidden");
  if (editorPaneEl.style.display !== "none") {
    previewPaneEl.style.flex = `1 1 ${100 - lastSplit}%`;
    editorPaneEl.style.flex = `1 1 ${lastSplit}%`;
    resizerEl.style.display = "block";
  } else {
    previewPaneEl.style.flex = "1 1 100%";
  }
};

settingsToggleEl.addEventListener("click", () => {
  setSettingsOpen(!settingsPanelOpen).catch(() => {});
});
settingsCloseEl.addEventListener("click", () => {
  setSettingsOpen(false).catch(() => {});
});

themeModeEl.addEventListener("change", async () => {
  themeMode = themeModeEl.value;
  syncTheme();
  await ipcRenderer.invoke("set-theme-mode", themeMode).catch(() => {});
});

SYSTEM_THEME_QUERY.addEventListener("change", () => {
  if (themeMode === "system") {
    syncTheme();
  }
});

saveApiKeyEl.addEventListener("click", async () => {
  const apiKey = geminiKeyEl.value.trim();
  if (!apiKey) {
    geminiKeyStatusEl.textContent = "Enter a Gemini API key first.";
    return;
  }

  saveApiKeyEl.disabled = true;
  try {
    const settings = await ipcRenderer.invoke("save-gemini-api-key", { apiKey });
    geminiKeyEl.value = "";
    setGeminiApiKeyStatus(settings);
    setStatusMessage("Gemini API key saved.");
  } catch (error) {
    geminiKeyStatusEl.textContent = `Could not save Gemini API key: ${error.message}`;
  } finally {
    saveApiKeyEl.disabled = false;
  }
});

saveTranscriptionPromptEl.addEventListener("click", async () => {
  const prompt = transcriptionPromptEl.value;
  const promptSelection = captureTextSelection(transcriptionPromptEl);
  saveTranscriptionPromptEl.disabled = true;
  try {
    const result = await ipcRenderer.invoke("save-transcription-prompt", { prompt });
    setPromptContent(result?.transcriptionPrompt || prompt);
    saveTranscriptionPromptTextEl.classList.add("hidden");
    saveTranscriptionPromptIconEl.classList.remove("hidden");
    renderIcons();
    setTimeout(() => {
      saveTranscriptionPromptTextEl.classList.remove("hidden");
      saveTranscriptionPromptIconEl.classList.add("hidden");
      renderIcons();
    }, 1500);
    setStatusMessage("Transcription prompt saved.");
  } catch (error) {
    setStatusMessage(`Could not save transcription prompt: ${error.message}`);
  } finally {
    saveTranscriptionPromptEl.disabled = false;
    restoreTextSelection(transcriptionPromptEl, promptSelection);
  }
});

checkPermissionsEl.addEventListener("click", async () => {
  try {
    const result = await ipcRenderer.invoke("check-permissions");
    applyPermissionSummary(result?.permissions);
    syncShellState();
    setStatusMessage(result?.ok ? "Permissions check complete." : "Permissions check failed.");
  } catch (error) {
    setStatusMessage(`Permissions check failed: ${error.message}`);
  }
});

requestMicPermissionEl.addEventListener("click", async () => {
  try {
    await requestRendererMicrophoneAccess();
    const result = await ipcRenderer.invoke("request-microphone-permission");
    applyPermissionSummary(result?.permissions);
    setStatusMessage(result?.message || "Microphone permission updated.");
    if (result?.ok) {
      await refreshMicrophones();
    }
    syncShellState();
  } catch (error) {
    setStatusMessage(`Microphone permission request failed: ${error.message}`);
  }
});

selectFolderEl.addEventListener("click", async () => {
  if (!selectedFolderPath) return;
  try {
    await ipcRenderer.invoke("open-path", selectedFolderPath);
  } catch (error) {
    setStatusMessage(`Could not open recordings folder: ${error.message}`);
  }
});

openTranscriptFolderEl.addEventListener("click", async () => {
  if (!transcriptsFolderPath) return;
  try {
    await ipcRenderer.invoke("open-path", transcriptsFolderPath);
  } catch (error) {
    setStatusMessage(`Could not open transcripts folder: ${error.message}`);
  }
});

sidebarNewRecordingEl.addEventListener("click", () => {
  if (isRecording || isPendingStop) {
    switchView("setup");
    setStatusMessage("Recording in progress.");
    return;
  }

  selectNewRecordingState();
  switchView("setup");
});
sidebarRailNewRecordingEl.addEventListener("click", () => {
  if (isRecording || isPendingStop) {
    switchView("setup");
    setStatusMessage("Recording in progress.");
    return;
  }

  selectNewRecordingState();
  switchView("setup");
});
openTranscriptionPromptEl.addEventListener("click", () => {
  switchView("prompt");
  transcriptionPromptEl.focus();
});
closePromptViewEl.addEventListener("click", () => {
  switchView(selectedRecordingId && previousPrimaryView !== "setup" ? previousPrimaryView : (selectedRecordingId ? "review" : "setup"));
});
const importMediaIntoLibrary = async () => {
  try {
    setStatusMessage("Importing media...");
    const result = await ipcRenderer.invoke("import-media");
    const imported = Array.isArray(result?.imported) ? result.imported : [];
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
    await refreshRecordings({ autoSelectFirst: false, loadDetails: false });
    if (imported[0]?.id) {
      setSelectedRecordingId(imported[0].id);
      renderLibrary();
      const requestId = ++selectionRequestId;
      await updateSelection({ switchToReview: imported[0].isSelectable, requestId });
    }
    if (imported.length && rejected.length) {
      setStatusMessage(`Imported ${imported.length} item${imported.length === 1 ? "" : "s"}; skipped ${rejected.length} unsupported file${rejected.length === 1 ? "" : "s"}.`);
      return;
    }
    if (imported.length) {
      setStatusMessage(`Imported ${imported.length} item${imported.length === 1 ? "" : "s"}.`);
      return;
    }
    if (rejected.length) {
      setStatusMessage(`Skipped ${rejected.length} unsupported file${rejected.length === 1 ? "" : "s"}.`);
      return;
    }
    setStatusMessage("Import canceled.");
  } catch (error) {
    setStatusMessage(`Import failed: ${error.message}`);
  }
};

importRecordingsEl.addEventListener("click", () => {
  importMediaIntoLibrary();
});
sidebarRailImportRecordingsEl.addEventListener("click", () => {
  importMediaIntoLibrary();
});
refreshRecordingsEl.addEventListener("click", () => {
  refreshRecordings({ loadDetails: true });
});
appStatePrimaryEl.addEventListener("click", async () => {
  try {
    if (appShellState === "needs_screen_permission") {
      const result = await ipcRenderer.invoke("check-permissions");
      applyPermissionSummary(result?.permissions);
      syncShellState();
      setStatusMessage(result?.ok ? "Permissions check complete." : "Screen permission is still missing.");
      return;
    }

    if (appShellState === "needs_mic_permission") {
      await requestRendererMicrophoneAccess();
      const result = await ipcRenderer.invoke("request-microphone-permission");
      applyPermissionSummary(result?.permissions);
      if (result?.ok) {
        await refreshMicrophones();
      }
      syncShellState();
      setStatusMessage(result?.message || "Microphone permission updated.");
    }
  } catch (error) {
    setStatusMessage(error.message);
  }
});
appStateSecondaryEl.addEventListener("click", async () => {
  if (appShellState !== "needs_mic_permission") {
    return;
  }

  selectedMicDeviceId = "";
  selectedRendererMicDeviceId = "";
  microphoneSelectEl.value = "";
  await stopLiveMicMonitor();
  syncShellState();
  setStatusMessage("Continuing without microphone input.");
});
collapseSidebarEl.addEventListener("click", collapseSidebar);
restoreSidebarEl.addEventListener("click", restoreSidebar);
sidebarRailSettingsEl.addEventListener("click", async () => {
  restoreSidebar();
  await setSettingsOpen(true);
});

editRecordingFilenameEl.addEventListener("click", () => {
  startEditingRecordingFilename();
});

recordingFilenameEl.addEventListener("input", (event) => {
  recordingFilename = event.target.value;
  hasCustomRecordingFilename = Boolean(event.target.value.trim());
  if (isRecording || isPendingStop) {
    ipcRenderer.send("update-recording-filename", {
      filename: recordingFilename,
    });
  }
});

recordingFilenameEl.addEventListener("blur", () => {
  stopEditingRecordingFilename();
});

recordingFilenameEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    stopEditingRecordingFilename();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    if (hasCustomRecordingFilename) {
      recordingFilenameEl.value = recordingFilename;
    } else {
      refreshDefaultRecordingFilename({ force: true });
    }
    stopEditingRecordingFilename();
  }
});

microphoneSelectEl.addEventListener("change", async (event) => {
  selectedMicDeviceId = event.target.value;
  selectedRendererMicDeviceId = event.target.selectedOptions[0]?.dataset.rendererDeviceId || "";
  await startLiveMicMonitor(selectedRendererMicDeviceId);
});

recordButtonEl.addEventListener("click", () => {
  if (isPendingStart || isPendingStop) return;

  if (!isRecording) {
    (async () => {
      try {
        if (selectedMicDeviceId) {
          await requestRendererMicrophoneAccess();
        }
        isPendingStart = true;
        stopEditingRecordingFilename();
        stopRecordingFilenameClock();
        setRecordingButtonState();
        ipcRenderer.send("start-recording", {
          filename: recordingFilename,
          micDeviceId: selectedMicDeviceId || null,
        });
      } catch (error) {
        resetRecordingUiState(Date.now());
        setStatusMessage(`Failed to start recording: ${error.message}`);
      }
    })();
    return;
  }

  isPendingStop = true;
  freezeElapsedTimer();
  setRecordingButtonState();
  setStatusMessage("Stopping recording...");
  ipcRenderer.send("stop-recording");
});

outputFilePathEl.addEventListener("click", async () => {
  const selected = getSelectedRecording();
  const targetPath = selected?.path || outputFilePathEl.textContent;
  if (!targetPath || targetPath === "Start recording to see the file path") return;
  try {
    await ipcRenderer.invoke("open-path", path.dirname(targetPath));
  } catch (error) {
    setStatusMessage(`Could not open recording folder: ${error.message}`);
  }
});

playerToggleEl.addEventListener("click", async () => {
  if (!recordingPlayerEl.src || isPlaybackLoading || playerToggleEl.disabled) return;
  if (recordingPlayerEl.paused) {
    if (
      Number.isFinite(recordingPlayerEl.duration)
      && recordingPlayerEl.duration > 0
      && recordingPlayerEl.currentTime >= recordingPlayerEl.duration
    ) {
      recordingPlayerEl.currentTime = 0;
    }
    await recordingPlayerEl.play().catch((error) => {
      setStatusMessage(`Playback failed: ${error.message}`);
    });
  } else {
    stopPlayback({ resetPosition: true });
  }
  updatePlayerUi();
});

playerSeekEl.addEventListener("click", (event) => {
  if (isPlaybackLoading || playerSeekEl.disabled) return;
  const bounds = playerSeekEl.getBoundingClientRect();
  const ratio = (event.clientX - bounds.left) / bounds.width;
  if (Number.isFinite(recordingPlayerEl.duration) && recordingPlayerEl.duration > 0) {
    recordingPlayerEl.currentTime = Math.max(0, Math.min(recordingPlayerEl.duration, recordingPlayerEl.duration * ratio));
    updatePlayerUi();
  }
});

recordingPlayerEl.addEventListener("loadedmetadata", () => {
  setPlaybackControlsState({ enabled: true, loading: false });
  updatePlayerUi();
});
recordingPlayerEl.addEventListener("canplay", () => {
  setPlaybackControlsState({ enabled: true, loading: false });
  updatePlayerUi();
});
recordingPlayerEl.addEventListener("loadstart", () => {
  if (recordingPlayerEl.currentSrc) {
    setPlaybackControlsState({ enabled: false, loading: true });
  }
});
recordingPlayerEl.addEventListener("timeupdate", updatePlayerUi);
recordingPlayerEl.addEventListener("durationchange", updatePlayerUi);
recordingPlayerEl.addEventListener("play", updatePlayerUi);
recordingPlayerEl.addEventListener("pause", updatePlayerUi);
recordingPlayerEl.addEventListener("ended", () => stopPlayback({ resetPosition: true }));
recordingPlayerEl.addEventListener("error", () => {
  setPlaybackControlsState({ enabled: false, loading: false });
  setStatusMessage("Playback failed for this file format in the embedded player.");
});

titleEditButtonEl.addEventListener("click", () => {
  const isEditing = reviewTitleEl.getAttribute("contenteditable") === "true";
  const nextIsEditing = !isEditing;
  reviewTitleEl.setAttribute("contenteditable", nextIsEditing ? "true" : "false");
  reviewTitleEl.classList.toggle("title-edit-active", nextIsEditing);
  titleEditIconEl.setAttribute("data-lucide", nextIsEditing ? "check" : "pen");
  titleEditButtonEl.title = nextIsEditing ? "Save title" : "Edit title";
  renderIcons();
  if (nextIsEditing) {
    previousReviewTitle = reviewTitleEl.textContent.trim();
    updateReviewTitleEditState();
    reviewTitleEl.focus();
    document.execCommand("selectAll", false, null);
  } else {
    reviewTitleEl.blur();
  }
});

reviewTitleEl.addEventListener("blur", () => {
  reviewTitleEl.setAttribute("contenteditable", "false");
  reviewTitleEl.classList.remove("title-edit-active");
  delete reviewTitleEl.dataset.empty;
  titleEditIconEl.setAttribute("data-lucide", "pen");
  titleEditButtonEl.title = "Edit title";
  renderIcons();

  const selected = getSelectedRecording();
  if (!selected) return;
  const nextTitle = reviewTitleEl.textContent.trim();
  if (!nextTitle) {
    reviewTitleEl.textContent = previousReviewTitle || getRecordingLabel(selected);
    return;
  }
  const normalizedTitle = nextTitle.replace(/\s+/gu, " ").trim();
  reviewTitleEl.textContent = normalizedTitle;
  ipcRenderer.invoke("rename-recording", {
    recordingId: selected.id,
    displayName: normalizedTitle,
  }).then((updated) => {
    selected.displayName = updated?.displayName || normalizedTitle;
    selected.name = selected.displayName;
    previousReviewTitle = selected.displayName;
    renderLibrary();
    setStatusMessage(`Renamed to ${selected.displayName}`);
  }).catch((error) => {
    reviewTitleEl.textContent = previousReviewTitle || getRecordingLabel(selected);
    setStatusMessage(`Rename failed: ${error.message}`);
  });
});

reviewTitleEl.addEventListener("input", () => {
  if (reviewTitleEl.getAttribute("contenteditable") === "true") {
    updateReviewTitleEditState();
  }
});

reviewTitleEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    reviewTitleEl.blur();
  }
});

openTranscriptButtonEl.addEventListener("click", async () => {
  if (!transcriptPath) return;
  try {
    await ipcRenderer.invoke("open-path", transcriptPath);
  } catch (error) {
    setStatusMessage(`Could not open transcript: ${error.message}`);
  }
});

reviewWarningRetryEl.addEventListener("click", () => {
  if (reviewWarningRetryEl.disabled) {
    return;
  }
  processButtonEl.click();
});

reviewWarningAcceptEl.addEventListener("click", async () => {
  const selected = getSelectedRecording();
  if (!selected || !selected.canAcceptTranscript) {
    return;
  }

  reviewWarningAcceptEl.disabled = true;
  reviewWarningAcceptEl.classList.add("disabled-button");
  try {
    await ipcRenderer.invoke("accept-transcript", {
      recordingId: selected.id,
    });
    selected.status = "ready";
    selected.statusDetail = null;
    selected.qualityFlags = [];
    selected.canAcceptTranscript = false;
    renderLibrary();
    updateReviewWarningState(selected);
    setStatusMessage("Transcript accepted.");
    await refreshRecordings({ autoSelectFirst: false });
  } catch (error) {
    setStatusMessage(`Could not accept transcript: ${error.message}`);
  } finally {
    updateReviewWarningState(selected);
  }
});

modelSelectEl.addEventListener("change", async () => {
  updateSelectedModelDescription();
  await refreshRecordingAnalysis();
});

processButtonEl.addEventListener("click", async () => {
  const selected = getSelectedRecording();
  if (!selected) {
    setStatusMessage("Select a recording first.");
    return;
  }

  if (selected.status === "transcribing") {
    if (isStoppingTranscription) {
      return;
    }

    isStoppingTranscription = true;
    setProcessButtonState({ isLoading: false });
    try {
      await ipcRenderer.invoke("cancel-transcription", {
        recordingId: selected.id,
      });
      setStatusMessage("Stopping transcription...");
    } catch (error) {
      setStatusMessage(`Could not stop transcription: ${error.message}`);
    } finally {
      isStoppingTranscription = false;
      setProcessButtonState({ isLoading: false });
    }
    return;
  }

  if (!selected.canTranscribe) {
    setStatusMessage("This recording cannot be transcribed because its media file is unavailable.");
    return;
  }

  if (selectedRecordingHasTranscript) {
    const shouldOverride = await askRetranscribeOverride();
    if (!shouldOverride) {
      return;
    }
  }

  isStartingTranscription = true;
  setProcessButtonState({ isLoading: true });
  const transcriptionRequest = ipcRenderer.invoke("process-recording", {
    recordingId: selected.id,
    model: modelSelectEl.value,
  });

  transcriptionRequest.then((result) => {
    if (result?.canceled) {
      setStatusMessage("Transcription stopped.");
      refreshRecordings({ autoSelectFirst: false, loadDetails: false });
      return;
    }
    transcriptPath = result.transcriptPath;
    selectedRecordingHasTranscript = true;
    selected.transcriptPath = result.transcriptPath;
    selected.status = result.status || "ready";
    selected.statusDetail = result.status === "needs_review"
      ? "Gemini returned low-confidence transcript content. Review before relying on it."
      : null;
    selected.qualityFlags = Array.isArray(result.qualityFlags) ? result.qualityFlags : [];
    selected.canAcceptTranscript = selected.status === "needs_review";
    setEditorContent(result.markdown, { resetHistory: true });
    saveBtnEl.disabled = false;
    saveBtnEl.classList.remove("disabled-button");
    updateReviewWarningState(selected);
    renderLibrary();
    setStatusMessage(
      result.status === "needs_review"
        ? `Transcript saved with warnings: ${getRecordingLabel(selected)}`
        : `Transcript ready: ${getRecordingLabel(selected)}`
    );
  }).catch((error) => {
    setStatusMessage(`Processing failed: ${error.message}`);
  }).finally(() => {
    isStartingTranscription = false;
    isStoppingTranscription = false;
    setProcessButtonState({ isLoading: false });
  });
});

collapseEditorEl.addEventListener("click", () => collapsePane("editor"));
restoreEditorEl.addEventListener("click", () => restorePane("editor"));
collapsePreviewEl.addEventListener("click", () => collapsePane("preview"));
restorePreviewEl.addEventListener("click", () => restorePane("preview"));

undoBtnEl.addEventListener("click", undoEditor);
redoBtnEl.addEventListener("click", redoEditor);
promptUndoBtnEl.addEventListener("click", undoPrompt);
promptRedoBtnEl.addEventListener("click", redoPrompt);

toggleFindEl.addEventListener("click", () => {
  labelsBarEl.classList.add("hidden");
  findBarEl.classList.toggle("hidden");
});

toggleLabelsEl.addEventListener("click", () => {
  findBarEl.classList.add("hidden");
  labelsBarEl.classList.toggle("hidden");
});

speakerDropdownEl.addEventListener("change", () => {
  speakerLabelEl.classList.toggle("hidden", speakerDropdownEl.value !== "custom");
});

replaceSpeakerEl.addEventListener("click", () => {
  const selectedSpeaker = speakerDropdownEl.value === "custom" ? speakerLabelEl.value.trim() : speakerDropdownEl.value;
  const replacement = speakerNameEl.value.trim();
  if (!selectedSpeaker || !replacement) return;
  const escaped = selectedSpeaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  setEditorContent(markdownEditorEl.value.replace(new RegExp(escaped, "g"), replacement));
  speakerNameEl.value = "";
});

findInputEl.addEventListener("input", () => updateSearchMatches({ focusEditor: false }));
findNowEl.addEventListener("click", () => updateSearchMatches());
searchPrevEl.addEventListener("click", () => {
  if (!searchMatches.length) {
    updateSearchMatches();
    return;
  }
  selectMatchByIndex(activeSearchIndex - 1);
});
searchNextEl.addEventListener("click", () => {
  if (!searchMatches.length) {
    updateSearchMatches();
    return;
  }
  selectMatchByIndex(activeSearchIndex + 1);
});
replaceOneEl.addEventListener("click", replaceCurrentMatch);
replaceAllEl.addEventListener("click", replaceAllMatches);

markdownEditorEl.addEventListener("input", () => {
  if (isApplyingHistory) return;
  renderPreview();
  updateSearchMatches({ focusEditor: false });
  syncHistoryFromEditor(markdownEditorEl.value);
  populateSpeakerDropdown();
});

transcriptionPromptEl.addEventListener("input", () => {
  if (isApplyingPromptHistory) return;
  syncHistoryFromPrompt(transcriptionPromptEl.value);
});

saveBtnEl.addEventListener("click", async () => {
  const selected = getSelectedRecording();
  if (!selected) return;
  const editorSelection = captureTextSelection(markdownEditorEl);
  try {
    const result = await ipcRenderer.invoke("save-markdown", {
      recordingId: selected.id,
      markdownPath: transcriptPath,
      content: markdownEditorEl.value,
    });
    if (result?.transcriptPath) {
      transcriptPath = result.transcriptPath;
      selected.transcriptPath = result.transcriptPath;
      selectedRecordingHasTranscript = true;
      openTranscriptButtonEl.disabled = false;
      openTranscriptButtonEl.classList.remove("disabled-button");
    }
    saveBtnTextEl.classList.add("hidden");
    saveBtnIconEl.classList.remove("hidden");
    renderIcons();
    setTimeout(() => {
      saveBtnTextEl.classList.remove("hidden");
      saveBtnIconEl.classList.add("hidden");
      renderIcons();
    }, 1500);
    setStatusMessage(`Saved transcript for ${getRecordingLabel(selected)}`);
  } catch (error) {
    setStatusMessage(`Save failed: ${error.message}`);
  } finally {
    restoreTextSelection(markdownEditorEl, editorSelection);
  }
});

saveBtnEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

saveTranscriptionPromptEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

copyMarkdownEl.addEventListener("click", () => {
  clipboard.writeText(markdownEditorEl.value || "");
  setStatusMessage("Markdown copied.");
});

deleteRecordingEl.addEventListener("click", async () => {
  const selected = getSelectedRecording();
  if (!selected) {
    setStatusMessage("Select a recording first.");
    return;
  }

  const recordingLabel = getRecordingLabel(selected);
  const shouldDelete = await askDeleteRecordingConfirm(recordingLabel);
  if (!shouldDelete) {
    return;
  }

  deleteRecordingEl.disabled = true;
  try {
    await ipcRenderer.invoke("delete-recording", {
      recordingId: selected.id,
    });
    if (selectedRecordingId === selected.id) {
      setSelectedRecordingId("");
    }
    if (currentRecordingId === selected.id && !isRecording && !isPendingStart && !isPendingStop) {
      currentRecordingId = "";
    }
    await refreshRecordings({ autoSelectFirst: false, loadDetails: false });
    await updateSelection({ switchToReview: false });
    switchView("setup");
    setStatusMessage(`Deleted ${recordingLabel}.`);
  } catch (error) {
    setStatusMessage(`Delete failed: ${error.message}`);
  } finally {
    syncDeleteButtonState();
  }
});

exportMp3El.addEventListener("click", async () => {
  const selected = getSelectedRecording();
  if (!selected) {
    setStatusMessage("Select a recording first.");
    return;
  }

  if (!selected.canExport || BUSY_RECORDING_STATUSES.has(selected.status)) {
    setStatusMessage(
      BUSY_RECORDING_STATUSES.has(selected.status)
        ? "Export is unavailable while this item is still being processed."
        : "This recording cannot be exported because its media file is unavailable."
    );
    return;
  }

  const exportMode = await askMp3ExportMode();
  if (!exportMode) {
    return;
  }

  exportMp3El.disabled = true;
  try {
    const result = await ipcRenderer.invoke("export-recording-mp3", {
      recordingId: selected.id,
      chunked: exportMode === "chunked",
    });

    if (result.chunked) {
      setStatusMessage(`MP3 chunks ready: ${result.fileCount} files in ${path.basename(result.outputDirectory)}`);
      await ipcRenderer.invoke("open-path", result.outputDirectory).catch(() => {});
    } else {
      setStatusMessage(`MP3 ready: ${path.basename(result.outputPath)}`);
      await ipcRenderer.invoke("open-path", path.dirname(result.outputPath)).catch(() => {});
    }
  } catch (error) {
    setStatusMessage(`MP3 export failed: ${error.message}`);
  } finally {
    exportMp3El.disabled = !selected.canExport;
    exportMp3El.classList.toggle("disabled-button", !selected.canExport);
  }
});

mp3ExportSingleEl.addEventListener("click", () => closeMp3ExportModal("single"));
mp3ExportChunkedEl.addEventListener("click", () => closeMp3ExportModal("chunked"));
mp3ExportCancelEl.addEventListener("click", () => closeMp3ExportModal(null));
mp3ExportModalEl.addEventListener("click", (event) => {
  if (event.target === mp3ExportModalEl) {
    closeMp3ExportModal(null);
  }
});
retranscribeConfirmEl.addEventListener("click", () => closeRetranscribeModal(true));
retranscribeCancelEl.addEventListener("click", () => closeRetranscribeModal(false));
retranscribeModalEl.addEventListener("click", (event) => {
  if (event.target === retranscribeModalEl) {
    closeRetranscribeModal(false);
  }
});
deleteRecordingConfirmEl.addEventListener("click", () => closeDeleteRecordingModal(true));
deleteRecordingCancelEl.addEventListener("click", () => closeDeleteRecordingModal(false));
deleteRecordingModalEl.addEventListener("click", (event) => {
  if (event.target === deleteRecordingModalEl) {
    closeDeleteRecordingModal(false);
  }
});
toggleDebugConsoleEl.addEventListener("click", () => {
  setDebugConsoleOpen(!debugConsoleOpen);
});
closeDebugConsoleEl.addEventListener("click", () => {
  setDebugConsoleOpen(false);
});
clearDebugConsoleEl.addEventListener("click", () => {
  debugConsoleEntries = [];
  renderDebugConsole();
});
copyDebugConsoleEl.addEventListener("click", () => {
  const text = debugConsoleEntries
    .map((entry) => `[${entry.timestamp}] [${entry.scope}] ${entry.extra ? `${entry.message} ${entry.extra}` : entry.message}`.trim())
    .join("\n");
  clipboard.writeText(text);
  setStatusMessage("Debug console copied.");
});

resizerEl.addEventListener("mousedown", () => {
  const onMove = (moveEvent) => {
    const ratio = ((moveEvent.clientX - workspaceContainerEl.getBoundingClientRect().left) / workspaceContainerEl.clientWidth) * 100;
    if (ratio > 10 && ratio < 90) {
      lastSplit = ratio;
      if (editorPaneEl.style.display !== "none" && previewPaneEl.style.display !== "none") {
        editorPaneEl.style.flex = `1 1 ${ratio}%`;
        previewPaneEl.style.flex = `1 1 ${100 - ratio}%`;
        updateEditorHeaderLayout();
      }
    }
  };
  const stop = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", stop);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", stop);
});

sidebarResizerEl.addEventListener("mousedown", () => {
  const onMove = (moveEvent) => {
    const containerLeft = document.body.getBoundingClientRect().left;
    const nextWidth = Math.max(180, Math.min(420, moveEvent.clientX - containerLeft));
    sidebarWidth = nextWidth;
    sidebarPaneEl.style.width = `${nextWidth}px`;
  };
  const stop = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", stop);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", stop);
});

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    setDebugConsoleOpen(!debugConsoleOpen);
    return;
  }
  if (!event.metaKey) return;
  const key = event.key.toLowerCase();
  if (currentView === "prompt") {
    if (key === "z" && event.shiftKey) {
      event.preventDefault();
      redoPrompt();
      return;
    }
    if (key === "z") {
      event.preventDefault();
      undoPrompt();
      return;
    }
    if (key === "y") {
      event.preventDefault();
      redoPrompt();
    }
    return;
  }
  if (key === "z" && event.shiftKey) {
    event.preventDefault();
    redoEditor();
    return;
  }
  if (key === "z") {
    event.preventDefault();
    undoEditor();
    return;
  }
  if (key === "y") {
    event.preventDefault();
    redoEditor();
  }
});

ipcRenderer.on("recording-status", async (_, status, timestamp, filepath, details) => {
  if (status === "START_RECORDING") {
    await refreshRecordings({ autoSelectFirst: false, loadDetails: false });
    const matchingRecording = filepath ? getRecordingByPath(filepath) : null;
    currentRecordingId = matchingRecording?.id || currentRecordingId;
    if (matchingRecording) {
      setSelectedRecordingId(matchingRecording.id);
      renderLibrary();
    }
    stopRecordingFilenameClock();
    isRecording = true;
    isPendingStart = false;
    isPendingStop = false;
    isEditingRecordingTitle = false;
    setRecordingButtonState();
    startElapsedTimer(timestamp);
    microphoneSelectEl.disabled = true;
    outputFilePathEl.textContent = filepath;
    setStatusMessage("Recording in progress.");
    switchView("setup");
    return;
  }

  if (status === "STOPPING_RECORDING") {
    isPendingStop = true;
    freezeElapsedTimer();
    setRecordingButtonState();
    setStatusMessage("Finalizing recording...");
    switchView("setup");
    await refreshRecordings({ autoSelectFirst: false, loadDetails: false });
    if (filepath) {
      const matchingRecording = getRecordingByPath(filepath);
      if (matchingRecording) {
        currentRecordingId = matchingRecording.id;
        setSelectedRecordingId(matchingRecording.id);
        renderLibrary();
      }
    }
    return;
  }

  if (status === "STOP_RECORDING") {
    resetRecordingUiState(timestamp);
    currentRecordingId = "";
    if (filepath) {
      outputFilePathEl.textContent = filepath;
      setSelectedRecordingId("");
    }
    await refreshRecordings({ autoSelectFirst: false, loadDetails: false });
    if (filepath) {
      const matchingRecording = getRecordingByPath(filepath);
      if (matchingRecording) {
        currentRecordingId = matchingRecording.id;
        setSelectedRecordingId(matchingRecording.id);
      }
    }
    await updateSelection({ switchToReview: true });
    setStatusMessage("Recording stopped.");
    return;
  }

  if (status === "RECORDING_STOPPED_UNEXPECTEDLY") {
    resetRecordingUiState(timestamp);
    currentRecordingId = "";
    if (filepath) {
      outputFilePathEl.textContent = filepath;
      setSelectedRecordingId("");
    }
    await refreshRecordings({ autoSelectFirst: false, loadDetails: false });
    if (filepath) {
      const matchingRecording = getRecordingByPath(filepath);
      if (matchingRecording) {
        currentRecordingId = matchingRecording.id;
        setSelectedRecordingId(matchingRecording.id);
      }
    }
    await updateSelection({ switchToReview: true });
    setStatusMessage(details ? `Recording stopped unexpectedly: ${details}` : "Recording stopped unexpectedly.");
    return;
  }

  if (status === "START_FAILED") {
    currentRecordingId = "";
    resetRecordingUiState(timestamp);
    setStatusMessage(details ? `Failed to start recording: ${details}` : "Failed to start recording. Check permissions and try again.");
  }
});

ipcRenderer.on("internal-log-entry", (_, entry) => {
  appendDebugEntry(entry);
});

ipcRenderer.on("recording-levels", (_, levels) => {
  recorderSystemLevel = levels?.systemLevel || 0;
  recorderMicLevel = levels?.micLevel || 0;
  refreshDisplayedAudioLevels();
});

ipcRenderer.on("library-updated", async () => {
  await scheduleRefreshRecordings({ autoSelectFirst: false });
});

const resolveBootstrapSelectionId = ({ recordings: nextRecordings = [], recordingState, taskState, sessionState }) => {
  if (recordingState?.recordingId && nextRecordings.some((recording) => recording.id === recordingState.recordingId)) {
    return recordingState.recordingId;
  }

  const busyRecordingId = (taskState?.busyRecordingIds || []).find((recordingId) => nextRecordings.some((recording) => recording.id === recordingId));
  if (busyRecordingId) {
    return busyRecordingId;
  }

  if (sessionState?.selectedRecordingId && nextRecordings.some((recording) => recording.id === sessionState.selectedRecordingId)) {
    return sessionState.selectedRecordingId;
  }

  return "";
};

const resolveBootstrapView = ({ recordingState, selectedRecording, sessionState }) => {
  if (recordingState?.isRecording) {
    return "setup";
  }

  if (!selectedRecording) {
    return "setup";
  }

  if (BUSY_RECORDING_STATUSES.has(selectedRecording.status) || selectedRecording.status === "needs_review") {
    return "review";
  }

  return sessionState?.lastPrimaryView === "setup"
    ? "review"
    : (sessionState?.lastPrimaryView || "review");
};

const init = async () => {
  try {
    installDebugConsoleHooks();
    renderIcons();
    await loadDebugConsoleHistory();
    appendDebugEntry({
      scope: "debug-console",
      message: "Debug console initialized.",
    });
    updateShellState("booting");

    const bootstrap = await ipcRenderer.invoke("get-app-bootstrap-state");
    const {
      storagePaths,
      geminiSettings,
      recordingState,
      uiState,
      taskState,
      permissions,
      recordings: bootstrapRecordings,
    } = bootstrap;

    selectedFolderPath = storagePaths.recordingsPath;
    transcriptsFolderPath = storagePaths.transcriptsPath;
    selectedFolderPathEl.textContent = selectedFolderPath;
    selectedTranscriptsPathEl.textContent = transcriptsFolderPath;
    openTranscriptFolderEl.disabled = false;

    bootstrapSessionState = uiState?.sessionState || bootstrapSessionState;
    applyPermissionSummary(permissions);
    setGeminiApiKeyStatus(geminiSettings);
    setPromptContent(geminiSettings?.transcriptionPrompt || "", { resetHistory: true });

    themeMode = uiState?.themeMode || "system";
    syncTheme();

    settingsPanelOpen = Boolean(uiState?.disclosureState?.[DISCLOSURE_SETTINGS_PANEL]);
    await setSettingsOpen(settingsPanelOpen, { persist: false });

    refreshDefaultRecordingFilename({ force: true });
    startRecordingFilenameClock();
    syncRecordingFilenameFieldState();

    if ((taskState?.busyRecordingIds || []).length) {
      updateShellState("recovering");
    }

    await loadTranscriptionModels();
    await loadAvailableMicrophonesIfGranted();

    const normalizedBootstrapRecordings = normalizeRecordings(bootstrapRecordings);
    const preferredRecordingId = resolveBootstrapSelectionId({
      recordings: normalizedBootstrapRecordings,
      recordingState,
      taskState,
      sessionState: bootstrapSessionState,
    });

    if (preferredRecordingId) {
      setSelectedRecordingId(preferredRecordingId, { persist: false });
    }

    await applyRecordingsSnapshot(normalizedBootstrapRecordings, {
      autoSelectFirst: false,
      loadDetails: Boolean(preferredRecordingId),
      preferredRecordingId,
    });

    applyRecordingStateSnapshot(recordingState);

    const selectedRecording = getSelectedRecording();
    switchView(resolveBootstrapView({
      recordingState,
      selectedRecording,
      sessionState: bootstrapSessionState,
    }));
    syncShellState();

    renderPreview();
    updateSearchMatches({ focusEditor: false });
    updatePlayerUi();
    updateHistoryButtons();
    updatePromptHistoryButtons();
    updateEditorHeaderLayout();
    updateReviewWarningState(selectedRecording);

    if (window.ResizeObserver && editorPaneEl && editorHeaderLayoutEl) {
      editorHeaderResizeObserver = new ResizeObserver(() => {
        updateEditorHeaderLayout();
      });
      editorHeaderResizeObserver.observe(editorPaneEl);
      editorHeaderResizeObserver.observe(editorHeaderLayoutEl);
    }
  } catch (error) {
    appendDebugEntry({
      scope: "init",
      message: error.message || String(error),
      level: "error",
    });
    updateShellState("setup");
    setStatusMessage(`Initialization failed: ${error.message}`);
  }
};

window.addEventListener("beforeunload", () => {
  editorHeaderResizeObserver?.disconnect();
  stopRecordingFilenameClock();
  stopLiveMicMonitor().catch(() => {});
});

init();
