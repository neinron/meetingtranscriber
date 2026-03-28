const { ipcRenderer, clipboard } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const MarkdownIt = require("markdown-it");

const markdownParser = new MarkdownIt({
  breaks: true,
  linkify: true,
});

const HISTORY_LIMIT = 100;
const DISCLOSURE_SETTINGS_PANEL = "settingsPanel";
const SYSTEM_THEME_QUERY = window.matchMedia("(prefers-color-scheme: dark)");

let selectedFolderPath = "";
let transcriptsFolderPath = "";
let recordingFilename = "";
let selectedMicDeviceId = "";
let selectedRendererMicDeviceId = "";
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
let sidebarWidth = 256;
let previousReviewTitle = "";
let selectionRequestId = 0;
let selectedRecordingHasTranscript = false;

const statusDisplayEl = document.getElementById("status-display");
const sidebarNewRecordingEl = document.getElementById("sidebar-new-recording");
const sidebarRailNewRecordingEl = document.getElementById("sidebar-rail-new-recording");
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
const microphoneSelectEl = document.getElementById("mic-select");
const recordButtonEl = document.getElementById("record-btn");
const recordIconEl = document.getElementById("record-icon");
const timerDisplayEl = document.getElementById("timer-display");
const outputFilePathEl = document.getElementById("output-file-path");
const setupMetersEl = document.getElementById("setup-meters");
const meterSystemEl = document.getElementById("meter-system");
const meterMicEl = document.getElementById("meter-mic");
const reviewTitleEl = document.getElementById("review-title");
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
const previewContentEl = document.getElementById("preview-content");
const workspaceContainerEl = document.getElementById("workspace-container");
const mp3ExportModalEl = document.getElementById("mp3-export-modal");
const mp3ExportSingleEl = document.getElementById("mp3-export-single");
const mp3ExportChunkedEl = document.getElementById("mp3-export-chunked");
const mp3ExportCancelEl = document.getElementById("mp3-export-cancel");
const retranscribeModalEl = document.getElementById("retranscribe-modal");
const retranscribeConfirmEl = document.getElementById("retranscribe-confirm");
const retranscribeCancelEl = document.getElementById("retranscribe-cancel");
const openTranscriptionPromptEl = document.getElementById("open-transcription-prompt");
const closePromptViewEl = document.getElementById("close-prompt-view");
const promptUndoBtnEl = document.getElementById("prompt-undo-btn");
const promptRedoBtnEl = document.getElementById("prompt-redo-btn");
const saveTranscriptionPromptTextEl = document.getElementById("save-transcription-prompt-text");
const saveTranscriptionPromptIconEl = document.getElementById("save-transcription-prompt-icon");

const renderIcons = () => {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons();
  }
};

const setStatusMessage = (message) => {
  statusDisplayEl.textContent = message;
  searchStatusEl.textContent = message;
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

const switchView = (view) => {
  const nextView = ["setup", "review", "prompt"].includes(view) ? view : "setup";
  if (nextView !== "prompt") {
    previousPrimaryView = nextView;
  }
  currentView = nextView;
  setupViewEl.classList.toggle("hidden", nextView !== "setup");
  reviewViewEl.classList.toggle("hidden", nextView !== "review");
  promptViewEl.classList.toggle("hidden", nextView !== "prompt");
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
const getRecordingByPath = (recordingPath) => recordings.find((recording) => recording.path === recordingPath) || null;
const isLatestSelectionRequest = (requestId) => requestId === selectionRequestId;
const normalizeRecordings = (items = []) => items.map((recording) => ({
  ...recording,
  id: recording.id || recording.path,
}));

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
  const micLevel = isRecording ? Math.max(recorderMicLevel, liveMicLevel) : liveMicLevel;
  setAudioLevels(systemLevel, micLevel);
};

const setRecordingButtonState = () => {
  recordButtonEl.classList.remove("opacity-60");

  const setIdleButton = () => {
    recordButtonEl.style.background = "var(--button-main)";
    recordButtonEl.style.border = "1px solid var(--border-main)";
    recordButtonEl.style.color = "var(--text-soft)";
    recordIconEl.innerHTML = '<i data-lucide="mic" class="w-8 h-8 transition-transform group-active:scale-90"></i>';
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
};

const setProcessButtonState = ({ isLoading = false } = {}) => {
  processButtonEl.disabled = isLoading;
  processButtonEl.classList.toggle("btn-processing-loading", isLoading);
  processButtonEl.classList.toggle("disabled-button", isLoading);

  if (isLoading) {
    processButtonTextEl.innerHTML = 'TRANSCRIBING <span class="loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
    return;
  }

  processButtonTextEl.textContent = selectedRecordingHasTranscript ? "RETRANSCRIBE" : "TRANSCRIBE";
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

const resetRecordingUiState = (timestamp) => {
  isRecording = false;
  isPendingStart = false;
  isPendingStop = false;
  setRecordingButtonState();
  stopElapsedTimer(timestamp);
  recorderSystemLevel = 0;
  recorderMicLevel = 0;
  microphoneSelectEl.disabled = false;
  refreshDisplayedAudioLevels();
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
    item.className = `sidebar-item w-full p-2 rounded-lg cursor-pointer flex flex-col text-left ${selectedRecordingId === recording.id ? "active" : ""}`;
    item.innerHTML = `
      <span class="text-xs font-semibold truncate">${recording.name}</span>
      <span class="text-[9px]" style="color: var(--text-soft);">${new Date(recording.createdAt).toLocaleString()}</span>
    `;
    item.addEventListener("click", async () => {
      selectedRecordingId = recording.id;
      renderLibrary();
      const requestId = ++selectionRequestId;
      await updateSelection({ switchToReview: true, requestId });
    });
    recordingsListEl.appendChild(item);
  });
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
  if (!selected) {
    recordingAnalysis = null;
    updateEstimateDisplay();
    return;
  }

  try {
    recordingAnalysis = await ipcRenderer.invoke("get-recording-analysis", {
      filePath: selected.path,
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

const updateSelection = async ({ switchToReview = false, requestId = selectionRequestId } = {}) => {
  const selected = getSelectedRecording();
  if (!selected) {
    transcriptPath = null;
    selectedRecordingHasTranscript = false;
    reviewTitleEl.textContent = "Select a file";
    metaDateTimeEl.textContent = "-";
    metaSizeEl.textContent = "-";
    metaDurationStaticEl.textContent = "-";
    resetPlayerSource();
    setEditorContent("", { resetHistory: true });
    saveBtnEl.disabled = true;
    saveBtnEl.classList.add("disabled-button");
    exportMp3El.disabled = true;
    exportMp3El.classList.add("disabled-button");
    recordingAnalysis = null;
    updateEstimateDisplay();
    setProcessButtonState({ isLoading: false });
    if (!isRecording) {
      switchView("setup");
    }
    return;
  }

  reviewTitleEl.textContent = selected.name.replace(/\.flac$/i, "");
  metaDateTimeEl.textContent = new Date(selected.createdAt).toLocaleString();
  metaSizeEl.textContent = formatSize(selected.sizeBytes);
  exportMp3El.disabled = false;
  exportMp3El.classList.remove("disabled-button");

  await refreshRecordingAnalysis();
  if (!isLatestSelectionRequest(requestId)) return;

  try {
    resetPlayerSource();
    setPlaybackControlsState({ enabled: false, loading: true });
    const { playbackPath } = await ipcRenderer.invoke("get-playback-source", selected.path);
    if (!isLatestSelectionRequest(requestId)) return;
    recordingPlayerEl.src = pathToFileURL(playbackPath).href;
    recordingPlayerEl.load();
  } catch (error) {
    if (!isLatestSelectionRequest(requestId)) return;
    resetPlayerSource();
    setStatusMessage(`Playback preparation failed: ${error.message}`);
  }

  transcriptPath = selected.transcriptPath || null;
  selectedRecordingHasTranscript = false;
  if (transcriptPath) {
    try {
      const result = await ipcRenderer.invoke("load-markdown", transcriptPath);
      if (!isLatestSelectionRequest(requestId)) return;
      setEditorContent(result.content || "", { resetHistory: true });
      selectedRecordingHasTranscript = true;
      saveBtnEl.disabled = false;
      saveBtnEl.classList.remove("disabled-button");
      setStatusMessage(`Loaded transcript: ${path.basename(transcriptPath)}`);
    } catch {
      if (!isLatestSelectionRequest(requestId)) return;
      setEditorContent("", { resetHistory: true });
      saveBtnEl.disabled = false;
      saveBtnEl.classList.remove("disabled-button");
      setStatusMessage("No transcript yet for selected recording.");
    }
  } else {
    setEditorContent("", { resetHistory: true });
    saveBtnEl.disabled = true;
    saveBtnEl.classList.add("disabled-button");
    setStatusMessage("No transcript path available for selected recording.");
  }

  setProcessButtonState({ isLoading: false });

  if (switchToReview) {
    switchView("review");
  }
};

const refreshRecordings = async ({ switchToReview = false } = {}) => {
  try {
    recordings = normalizeRecordings(await ipcRenderer.invoke("list-recordings"));
    if (!recordings.some((recording) => recording.id === selectedRecordingId)) {
      selectedRecordingId = recordings[0]?.id || "";
    }
    renderLibrary();
    const requestId = ++selectionRequestId;
    await updateSelection({ switchToReview, requestId });
  } catch (error) {
    setStatusMessage(`Failed to load recordings: ${error.message}`);
  }
};

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
  modelSelectEl.innerHTML = "";

  modelCatalog.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    modelSelectEl.appendChild(option);
  });

  if (modelCatalog.some((model) => model.id === "gemini-2.5-flash")) {
    modelSelectEl.value = "gemini-2.5-flash";
  } else if (modelCatalog[0]) {
    modelSelectEl.value = modelCatalog[0].id;
  }

  updateSelectedModelDescription();
};

const applyRecordingStateSnapshot = (state) => {
  if (!state?.isRecording) {
    resetRecordingUiState(Date.now());
    return;
  }

  isRecording = true;
  isPendingStart = false;
  isPendingStop = false;
  setRecordingButtonState();
  startElapsedTimer(state.startedAtMs);
  microphoneSelectEl.disabled = true;
  outputFilePathEl.textContent = state.recordingPath || "Recording in progress";
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
  saveTranscriptionPromptEl.disabled = true;
  try {
    const result = await ipcRenderer.invoke("save-transcription-prompt", { prompt });
    setPromptContent(result?.transcriptionPrompt || prompt, { resetHistory: true });
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
  }
});

checkPermissionsEl.addEventListener("click", async () => {
  try {
    const result = await ipcRenderer.invoke("check-permissions");
    setStatusMessage(result?.ok ? "Permissions check complete." : "Permissions check failed.");
  } catch (error) {
    setStatusMessage(`Permissions check failed: ${error.message}`);
  }
});

requestMicPermissionEl.addEventListener("click", async () => {
  try {
    await requestRendererMicrophoneAccess();
    const result = await ipcRenderer.invoke("request-microphone-permission");
    setStatusMessage(result?.message || "Microphone permission updated.");
    if (result?.ok) {
      await refreshMicrophones();
    }
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

sidebarNewRecordingEl.addEventListener("click", () => switchView("setup"));
sidebarRailNewRecordingEl.addEventListener("click", () => switchView("setup"));
openTranscriptionPromptEl.addEventListener("click", () => {
  switchView("prompt");
  transcriptionPromptEl.focus();
});
closePromptViewEl.addEventListener("click", () => {
  switchView(selectedRecordingId && previousPrimaryView !== "setup" ? previousPrimaryView : (selectedRecordingId ? "review" : "setup"));
});
refreshRecordingsEl.addEventListener("click", refreshRecordings);
collapseSidebarEl.addEventListener("click", collapseSidebar);
restoreSidebarEl.addEventListener("click", restoreSidebar);
sidebarRailSettingsEl.addEventListener("click", async () => {
  restoreSidebar();
  await setSettingsOpen(true);
});

recordingFilenameEl.addEventListener("input", (event) => {
  recordingFilename = event.target.value;
  if (isRecording || isPendingStop) {
    ipcRenderer.send("update-recording-filename", {
      filename: recordingFilename,
    });
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
  setRecordingButtonState();
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
  reviewTitleEl.setAttribute("contenteditable", isEditing ? "false" : "true");
  reviewTitleEl.classList.toggle("title-edit-active", !isEditing);
  titleEditIconEl.setAttribute("data-lucide", isEditing ? "pen" : "check");
  renderIcons();
  if (!isEditing) {
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
  renderIcons();

  const selected = getSelectedRecording();
  if (!selected) return;
  const nextTitle = reviewTitleEl.textContent.trim();
  if (!nextTitle) {
    reviewTitleEl.textContent = previousReviewTitle || selected.name.replace(/\.flac$/i, "");
    return;
  }
  selected.name = selected.name.toLowerCase().endsWith(".flac") ? `${nextTitle}.flac` : nextTitle;
  previousReviewTitle = nextTitle;
  renderLibrary();
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

  if (selectedRecordingHasTranscript) {
    const shouldOverride = await askRetranscribeOverride();
    if (!shouldOverride) {
      return;
    }
  }

  setProcessButtonState({ isLoading: true });
  try {
    const result = await ipcRenderer.invoke("process-recording", {
      filePath: selected.path,
      model: modelSelectEl.value,
      transcriptPath: selected.transcriptPath,
    });
    transcriptPath = result.transcriptPath;
    selectedRecordingHasTranscript = true;
    selected.transcriptPath = result.transcriptPath;
    setEditorContent(result.markdown, { resetHistory: true });
    saveBtnEl.disabled = false;
    saveBtnEl.classList.remove("disabled-button");
    setStatusMessage(`Transcript ready: ${path.basename(transcriptPath)}`);
  } catch (error) {
    setStatusMessage(`Processing failed: ${error.message}`);
  } finally {
    setProcessButtonState({ isLoading: false });
  }
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
  if (!transcriptPath) return;
  try {
    await ipcRenderer.invoke("save-markdown", {
      markdownPath: transcriptPath,
      content: markdownEditorEl.value,
    });
    saveBtnTextEl.classList.add("hidden");
    saveBtnIconEl.classList.remove("hidden");
    renderIcons();
    setTimeout(() => {
      saveBtnTextEl.classList.remove("hidden");
      saveBtnIconEl.classList.add("hidden");
      renderIcons();
    }, 1500);
    setStatusMessage(`Saved ${path.basename(transcriptPath)}`);
  } catch (error) {
    setStatusMessage(`Save failed: ${error.message}`);
  }
});

copyMarkdownEl.addEventListener("click", () => {
  clipboard.writeText(markdownEditorEl.value || "");
  setStatusMessage("Markdown copied.");
});

exportMp3El.addEventListener("click", async () => {
  const selected = getSelectedRecording();
  if (!selected) {
    setStatusMessage("Select a recording first.");
    return;
  }

  const exportMode = await askMp3ExportMode();
  if (!exportMode) {
    return;
  }

  exportMp3El.disabled = true;
  try {
    const result = await ipcRenderer.invoke("export-recording-mp3", {
      filePath: selected.path,
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
    exportMp3El.disabled = false;
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

resizerEl.addEventListener("mousedown", () => {
  const onMove = (moveEvent) => {
    const ratio = ((moveEvent.clientX - workspaceContainerEl.getBoundingClientRect().left) / workspaceContainerEl.clientWidth) * 100;
    if (ratio > 10 && ratio < 90) {
      lastSplit = ratio;
      if (editorPaneEl.style.display !== "none" && previewPaneEl.style.display !== "none") {
        editorPaneEl.style.flex = `1 1 ${ratio}%`;
        previewPaneEl.style.flex = `1 1 ${100 - ratio}%`;
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
    isRecording = true;
    isPendingStart = false;
    isPendingStop = false;
    setRecordingButtonState();
    startElapsedTimer(timestamp);
    microphoneSelectEl.disabled = true;
    outputFilePathEl.textContent = filepath;
    setStatusMessage("Recording in progress.");
    switchView("setup");
    return;
  }

  if (status === "STOP_RECORDING") {
    resetRecordingUiState(timestamp);
    if (filepath) {
      outputFilePathEl.textContent = filepath;
      selectedRecordingId = "";
    }
    await refreshRecordings();
    if (filepath) {
      const matchingRecording = getRecordingByPath(filepath);
      if (matchingRecording) {
        selectedRecordingId = matchingRecording.id;
      }
    }
    await updateSelection({ switchToReview: true });
    setStatusMessage("Recording stopped.");
    return;
  }

  if (status === "RECORDING_STOPPED_UNEXPECTEDLY") {
    resetRecordingUiState(timestamp);
    if (filepath) {
      outputFilePathEl.textContent = filepath;
      selectedRecordingId = "";
    }
    await refreshRecordings();
    if (filepath) {
      const matchingRecording = getRecordingByPath(filepath);
      if (matchingRecording) {
        selectedRecordingId = matchingRecording.id;
      }
    }
    await updateSelection({ switchToReview: true });
    setStatusMessage(details ? `Recording stopped unexpectedly: ${details}` : "Recording stopped unexpectedly.");
    return;
  }

  if (status === "START_FAILED") {
    resetRecordingUiState(timestamp);
    setStatusMessage(details ? `Failed to start recording: ${details}` : "Failed to start recording. Check permissions and try again.");
  }
});

ipcRenderer.on("recording-levels", (_, levels) => {
  recorderSystemLevel = levels?.systemLevel || 0;
  recorderMicLevel = levels?.micLevel || 0;
  refreshDisplayedAudioLevels();
});

const init = async () => {
  try {
    renderIcons();

    const [storagePaths, geminiSettings, recordingState, uiState] = await Promise.all([
      ipcRenderer.invoke("get-storage-paths"),
      ipcRenderer.invoke("get-gemini-settings"),
      ipcRenderer.invoke("get-recording-state"),
      ipcRenderer.invoke("get-ui-state"),
    ]);

    selectedFolderPath = storagePaths.recordingsPath;
    transcriptsFolderPath = storagePaths.transcriptsPath;
    selectedFolderPathEl.textContent = selectedFolderPath;
    selectedTranscriptsPathEl.textContent = transcriptsFolderPath;
    openTranscriptFolderEl.disabled = false;

    setGeminiApiKeyStatus(geminiSettings);
    setPromptContent(geminiSettings?.transcriptionPrompt || "", { resetHistory: true });

    themeMode = uiState?.themeMode || "system";
    syncTheme();

    settingsPanelOpen = Boolean(uiState?.disclosureState?.[DISCLOSURE_SETTINGS_PANEL]);
    await setSettingsOpen(settingsPanelOpen, { persist: false });

    recordingFilename = getDefaultMeetingFilename();
    recordingFilenameEl.value = recordingFilename;

    await loadTranscriptionModels();
    await refreshRecordings();
    await loadAvailableMicrophonesIfGranted();
    applyRecordingStateSnapshot(recordingState);
    renderPreview();
    updateSearchMatches({ focusEditor: false });
    updatePlayerUi();
    updateHistoryButtons();
    updatePromptHistoryButtons();

    switchView("setup");
  } catch (error) {
    setStatusMessage(`Initialization failed: ${error.message}`);
  }
};

window.addEventListener("beforeunload", () => {
  stopLiveMicMonitor().catch(() => {});
});

init();
