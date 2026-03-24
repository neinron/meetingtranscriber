const { ipcRenderer } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const MarkdownIt = require("markdown-it");

const markdownParser = new MarkdownIt({
  breaks: true,
  linkify: true,
});

let selectedFolderPath = "";
let transcriptsFolderPath = "";
let recordingFilename = "";
let selectedMicDeviceId = "";
let recordings = [];
let transcriptPath = null;
let searchMatches = [];
let activeSearchIndex = -1;
let isRecording = false;
let isPendingStart = false;
let isPendingStop = false;
let selectedRendererMicDeviceId = "";
let liveMonitorStream = null;
let liveMonitorAudioContext = null;
let liveMonitorAnalyser = null;
let liveMonitorData = null;
let liveMonitorFrame = null;
let liveMicLevel = 0;
let recorderSystemLevel = 0;
let recorderMicLevel = 0;

let updateTimer = null;
let startTimeMs = null;

const selectedFolderPathEl = document.getElementById("selected-folder-path");
const selectedTranscriptsPathEl = document.getElementById("selected-transcripts-path");
const recordingSelectEl = document.getElementById("recording-select");
const recordingMetaEl = document.getElementById("recording-meta");
const processingStatusEl = document.getElementById("processing-status");
const markdownEditorEl = document.getElementById("markdown-editor");
const markdownPreviewEl = document.getElementById("markdown-preview");
const searchStatusEl = document.getElementById("search-status");
const recordingToggleEl = document.getElementById("recording-toggle");
const recordingStateLabelEl = document.getElementById("recording-state-label");
const microphoneSelectEl = document.getElementById("microphone-select");
const systemLevelFillEl = document.getElementById("system-level-fill");
const micLevelFillEl = document.getElementById("mic-level-fill");
const recordingPlayerEl = document.getElementById("recording-player");
const playerShellEl = document.getElementById("player-shell");
const saveMarkdownEl = document.getElementById("save-markdown");
const openTranscriptFolderEl = document.getElementById("open-transcript-folder");
const exportMp3El = document.getElementById("export-mp3");
const chunkMp3El = document.getElementById("chunk-mp3");
const searchInputEl = document.getElementById("search-input");
const replaceInputEl = document.getElementById("replace-input");
const checkPermissionsEl = document.getElementById("check-permissions");
const requestMicPermissionEl = document.getElementById("request-mic-permission");
const recordingFilenameEl = document.getElementById("recording-filename");

const getDefaultMeetingFilename = () => {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `Meeting_Recording-${dd}${mm}${yyyy}-${hh}${min}`;
};

const setAudioLevels = (systemLevel = 0, micLevel = 0) => {
  const systemPct = Math.max(0, Math.min(100, Math.round(systemLevel * 100)));
  const micPct = Math.max(0, Math.min(100, Math.round(micLevel * 100)));
  systemLevelFillEl.style.width = `${systemPct}%`;
  micLevelFillEl.style.width = `${micPct}%`;
};

const refreshDisplayedAudioLevels = () => {
  const systemLevel = isRecording ? recorderSystemLevel : 0;
  const micLevel = isRecording ? Math.max(recorderMicLevel, liveMicLevel) : liveMicLevel;
  setAudioLevels(systemLevel, micLevel);
};

const setRecordingToggleState = () => {
  recordingToggleEl.classList.remove("recording", "pending");

  if (isPendingStart) {
    recordingToggleEl.classList.add("pending");
    recordingToggleEl.textContent = "Starting";
    recordingStateLabelEl.textContent = "Initializing capture...";
    return;
  }

  if (isPendingStop) {
    recordingToggleEl.classList.add("pending", "recording");
    recordingToggleEl.textContent = "Stopping";
    recordingStateLabelEl.textContent = "Finalizing recording...";
    return;
  }

  if (isRecording) {
    recordingToggleEl.classList.add("recording");
    recordingToggleEl.textContent = "Stop";
    recordingStateLabelEl.textContent = "Recording in progress";
    return;
  }

  recordingToggleEl.textContent = "Start";
  recordingStateLabelEl.textContent = "Ready to record";
};

const resetRecordingUiState = (timestamp) => {
  isRecording = false;
  isPendingStart = false;
  isPendingStop = false;
  setRecordingToggleState();
  stopElapsedTimer(timestamp);
  document.getElementById("recording-filename").disabled = false;
  document.getElementById("select-folder").disabled = false;
  microphoneSelectEl.disabled = false;
  recorderSystemLevel = 0;
  recorderMicLevel = 0;
  refreshDisplayedAudioLevels();
};

const startElapsedTimer = (timestamp) => {
  clearTimeout(updateTimer);
  startTimeMs = Number.isFinite(timestamp) ? timestamp : Date.now();
  updateElapsedTime();
};

const stopElapsedTimer = (timestamp) => {
  clearTimeout(updateTimer);
  updateTimer = null;

  if (startTimeMs !== null) {
    const endTimeMs = Number.isFinite(timestamp) ? timestamp : Date.now();
    const elapsedTime = Math.max(0, Math.floor((endTimeMs - startTimeMs) / 1000));
    document.getElementById("elapsed-time").textContent = `${elapsedTime}s`;
  }

  startTimeMs = null;
};

function updateElapsedTime() {
  if (startTimeMs === null) return;

  const elapsedTime = Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000));
  document.getElementById("elapsed-time").textContent = `${elapsedTime}s`;
  updateTimer = setTimeout(updateElapsedTime, 1000);
}

const setProcessing = (isProcessing, label) => {
  document.getElementById("process-recording").disabled = isProcessing;
  processingStatusEl.textContent = label;
};

const setExporting = (isExporting, label) => {
  exportMp3El.disabled = isExporting;
  chunkMp3El.disabled = isExporting;
  processingStatusEl.textContent = label;
};

const setRecordingSelectionUi = (recording) => {
  const hasRecording = Boolean(recording);

  playerShellEl.classList.toggle("is-empty", !hasRecording);
  exportMp3El.disabled = !hasRecording;
};

const renderPreview = () => {
  const markdown = markdownEditorEl.value || "";

  try {
    markdownPreviewEl.innerHTML = markdownParser.render(markdown);
  } catch (error) {
    markdownPreviewEl.textContent = `Preview rendering failed: ${error.message}`;
  }
};

const formatSize = (sizeBytes) => {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
};

const normalizeMicrophoneName = (name) => {
  const trimmed = (name || "").trim();
  if (!trimmed) return "";

  return trimmed
    .replace(/^(default|standard)\s*[-:]\s*/i, "")
    .replace(/\s*\((built-in|default)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
};

const requestRendererMicrophoneAccess = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This build cannot request microphone access from the renderer.");
  }

  let stream = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch (error) {
    if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
      throw new Error("Microphone access was denied. Accept the macOS prompt for Meetlify, or enable Meetlify under System Settings > Privacy & Security > Microphone and relaunch the app.");
    }

    throw new Error(error?.message || "Could not access the microphone.");
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

const ensureMicrophonePromptOnLaunch = async () => {
  const permissionState = await ipcRenderer.invoke("get-microphone-permission-status");
  const status = permissionState?.status || "unknown";

  if (status === "not-determined") {
    try {
      await requestRendererMicrophoneAccess();
      processingStatusEl.textContent = "Microphone permission granted.";
    } catch (error) {
      processingStatusEl.textContent = error.message;
    }
    return;
  }

  if (status === "denied" || status === "restricted") {
    processingStatusEl.textContent = permissionState?.message || "Microphone access is not available.";
  }
};

const getRendererMicrophones = async () => {
  if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
    return [];
  }

  let stream = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaDevices = await navigator.mediaDevices.enumerateDevices();
    const dedupedDevices = new Map();

    mediaDevices
      .filter((device) => device.kind === "audioinput")
      .forEach((device) => {
        const rawName = (device.label || "").trim();
        const normalizedName = normalizeMicrophoneName(rawName) || "Microphone";
        const dedupeKey = normalizedName.toLowerCase();
        const existing = dedupedDevices.get(dedupeKey);
        const nextDevice = {
          id: normalizedName,
          name: normalizedName,
          isDefault: device.deviceId === "default",
          rendererDeviceId: device.deviceId,
        };

        if (!existing) {
          dedupedDevices.set(dedupeKey, nextDevice);
          return;
        }

        dedupedDevices.set(dedupeKey, {
          id: existing.isDefault ? existing.id : nextDevice.id,
          name: existing.name,
          isDefault: existing.isDefault || nextDevice.isDefault,
          rendererDeviceId: existing.isDefault ? existing.rendererDeviceId : nextDevice.rendererDeviceId,
        });
      });

    return Array.from(dedupedDevices.values());
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
};

const refreshMicrophones = async () => {
  try {
    let devices = [];

    try {
      devices = await getRendererMicrophones();
    } catch (error) {
      processingStatusEl.textContent = error.message;
    }

    if (!devices.length) {
      devices = await ipcRenderer.invoke("list-input-devices");
    }

    microphoneSelectEl.innerHTML = "";

    const noMicOption = document.createElement("option");
    noMicOption.value = "";
    noMicOption.textContent = "No microphone";
    microphoneSelectEl.appendChild(noMicOption);

    devices.forEach((device) => {
      const option = document.createElement("option");
      option.value = device.id;
      option.dataset.rendererDeviceId = device.rendererDeviceId || "";
      option.textContent = device.isDefault ? `${device.name} (Default)` : device.name;
      microphoneSelectEl.appendChild(option);
    });

    if (selectedMicDeviceId && devices.some((device) => device.id === selectedMicDeviceId)) {
      microphoneSelectEl.value = selectedMicDeviceId;
      selectedRendererMicDeviceId = microphoneSelectEl.selectedOptions[0]?.dataset.rendererDeviceId || "";
      await startLiveMicMonitor(selectedRendererMicDeviceId);
      return;
    }

    const defaultDevice = devices.find((device) => device.isDefault);
    selectedMicDeviceId = defaultDevice?.id || "";
    microphoneSelectEl.value = selectedMicDeviceId;
    selectedRendererMicDeviceId = microphoneSelectEl.selectedOptions[0]?.dataset.rendererDeviceId || "";
    await startLiveMicMonitor(selectedRendererMicDeviceId);
  } catch (error) {
    microphoneSelectEl.innerHTML = '<option value="">No microphone</option>';
    selectedMicDeviceId = "";
    selectedRendererMicDeviceId = "";
    await stopLiveMicMonitor();
    processingStatusEl.textContent = `Failed to load microphones: ${error.message}`;
  }
};

const updateRecordingMeta = async () => {
  const selectedPath = recordingSelectEl.value;
  const selected = recordings.find((recording) => recording.path === selectedPath);

  if (!selected) {
    recordingMetaEl.textContent = "";
    recordingPlayerEl.removeAttribute("src");
    recordingPlayerEl.load();
    setRecordingSelectionUi(null);
    return;
  }

  const modified = new Date(selected.modifiedAt).toLocaleString();
  const created = selected.createdAt ? new Date(selected.createdAt).toLocaleString() : modified;
  recordingMetaEl.textContent = `Size: ${formatSize(selected.sizeBytes)} • Created: ${created}`;
  setRecordingSelectionUi(selected);

  try {
    const { playbackPath } = await ipcRenderer.invoke("get-playback-source", selected.path);
    recordingPlayerEl.src = pathToFileURL(playbackPath).href;
    recordingPlayerEl.load();
  } catch (error) {
    recordingPlayerEl.removeAttribute("src");
    recordingPlayerEl.load();
    processingStatusEl.textContent = `Playback preparation failed: ${error.message}`;
  }
};

const loadTranscriptForSelection = async () => {
  const selectedPath = recordingSelectEl.value;
  const selected = recordings.find((recording) => recording.path === selectedPath);

  if (!selectedPath) {
    transcriptPath = null;
    markdownEditorEl.value = "";
    renderPreview();
    saveMarkdownEl.disabled = true;
    updateSearchMatches();
    return;
  }

  transcriptPath = selected?.transcriptPath || null;
  if (!transcriptPath) {
    processingStatusEl.textContent = "No transcript path available for selected recording.";
    return;
  }

  try {
    const result = await ipcRenderer.invoke("load-markdown", transcriptPath);
    markdownEditorEl.value = result.content || "";
    renderPreview();
    updateSearchMatches();
    saveMarkdownEl.disabled = false;
    processingStatusEl.textContent = `Loaded transcript: ${path.basename(transcriptPath)}`;
  } catch {
    markdownEditorEl.value = "";
    renderPreview();
    updateSearchMatches();
    saveMarkdownEl.disabled = false;
    processingStatusEl.textContent = "No transcript yet for selected recording.";
  }
};

const refreshRecordings = async () => {
  try {
    recordings = await ipcRenderer.invoke("list-recordings");
    recordingSelectEl.innerHTML = "";

    if (!recordings.length) {
      recordingSelectEl.innerHTML = '<option value="">No recordings found</option>';
      recordingMetaEl.textContent = "";
      recordingPlayerEl.removeAttribute("src");
      recordingPlayerEl.load();
      setRecordingSelectionUi(null);
      transcriptPath = null;
      markdownEditorEl.value = "";
      renderPreview();
      saveMarkdownEl.disabled = true;
      exportMp3El.disabled = true;
      updateSearchMatches();
      return;
    }

    recordings.forEach((recording, index) => {
      const option = document.createElement("option");
      option.value = recording.path;
      option.textContent = recording.name;
      if (index === 0) option.selected = true;
      recordingSelectEl.appendChild(option);
    });

    await updateRecordingMeta();
    await loadTranscriptForSelection();
  } catch (error) {
    processingStatusEl.textContent = `Failed to load recordings: ${error.message}`;
  }
};

const updateSearchStatus = () => {
  if (!searchInputEl.value) {
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
  const term = searchInputEl.value;
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

const gotoNextMatch = () => {
  if (!searchMatches.length) {
    updateSearchMatches();
    return;
  }

  selectMatchByIndex(activeSearchIndex + 1);
};

const gotoPrevMatch = () => {
  if (!searchMatches.length) {
    updateSearchMatches();
    return;
  }

  selectMatchByIndex(activeSearchIndex - 1);
};

const replaceCurrentMatch = () => {
  if (!searchInputEl.value) {
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
  markdownEditorEl.value = `${text.slice(0, match.start)}${replacement}${text.slice(match.end)}`;
  renderPreview();
  updateSearchMatches();

  if (searchMatches.length) {
    selectMatchByIndex(Math.min(activeSearchIndex, searchMatches.length - 1));
  }
};

const replaceAllMatches = () => {
  const term = searchInputEl.value;
  if (!term) {
    updateSearchStatus();
    return;
  }

  const replacement = replaceInputEl.value;
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escapedTerm, "gi");
  markdownEditorEl.value = markdownEditorEl.value.replace(regex, replacement);
  renderPreview();
  updateSearchMatches();
};

document.getElementById("select-folder").addEventListener("click", async () => {
  if (!selectedFolderPath) return;
  try {
    await ipcRenderer.invoke("open-path", selectedFolderPath);
  } catch (error) {
    processingStatusEl.textContent = `Could not open recordings folder: ${error.message}`;
  }
});

openTranscriptFolderEl.addEventListener("click", async () => {
  if (!transcriptsFolderPath) return;
  try {
    await ipcRenderer.invoke("open-path", transcriptsFolderPath);
  } catch (error) {
    processingStatusEl.textContent = `Could not open transcripts folder: ${error.message}`;
  }
});

checkPermissionsEl.addEventListener("click", async () => {
  try {
    const result = await ipcRenderer.invoke("check-permissions");
    if (result?.ok) {
      processingStatusEl.textContent = "Permissions check complete.";
      await refreshMicrophones();
    } else {
      processingStatusEl.textContent = "Permissions check failed.";
    }
  } catch (error) {
    processingStatusEl.textContent = `Permissions check failed: ${error.message}`;
  }
});

requestMicPermissionEl.addEventListener("click", async () => {
  try {
    await requestRendererMicrophoneAccess();
    const result = await ipcRenderer.invoke("request-microphone-permission");
    if (result?.ok) {
      processingStatusEl.textContent = "Microphone permission granted.";
      await refreshMicrophones();
      return;
    }
    processingStatusEl.textContent = result?.message || `Microphone permission status: ${result?.status || "unknown"}`;
  } catch (error) {
    processingStatusEl.textContent = `Microphone permission request failed: ${error.message}`;
  }
});

recordingFilenameEl.addEventListener("input", (event) => {
  recordingFilename = event.target.value;
});

recordingPlayerEl.addEventListener("error", () => {
  processingStatusEl.textContent = "Playback failed for this file format in the embedded player.";
});

microphoneSelectEl.addEventListener("change", (event) => {
  selectedMicDeviceId = event.target.value;
  selectedRendererMicDeviceId = event.target.selectedOptions[0]?.dataset.rendererDeviceId || "";
  startLiveMicMonitor(selectedRendererMicDeviceId).catch(() => {});
});

recordingToggleEl.addEventListener("click", () => {
  if (isPendingStart || isPendingStop) return;

  if (!isRecording) {
    (async () => {
      try {
        if (selectedMicDeviceId) {
          await requestRendererMicrophoneAccess();
        }

        isPendingStart = true;
        setRecordingToggleState();

        ipcRenderer.send("start-recording", {
          filename: recordingFilename,
          micDeviceId: selectedMicDeviceId || null,
        });
      } catch (error) {
        resetRecordingUiState(Date.now());
        processingStatusEl.textContent = `Failed to start recording: ${error.message}`;
      }
    })();

    return;
  }

  isPendingStop = true;
  setRecordingToggleState();
  ipcRenderer.send("stop-recording");
});

ipcRenderer.on("recording-status", async (_, status, timestamp, filepath, details) => {
  if (status === "START_RECORDING") {
    isRecording = true;
    isPendingStart = false;
    isPendingStop = false;
    setRecordingToggleState();
    startElapsedTimer(timestamp);

    document.getElementById("recording-filename").disabled = true;
    document.getElementById("select-folder").disabled = true;
    microphoneSelectEl.disabled = true;
    document.getElementById("output-file-path").textContent = filepath;
  }

  if (status === "STOP_RECORDING") {
    resetRecordingUiState(timestamp);
    await refreshRecordings();
    processingStatusEl.textContent = "Recording stopped.";
  }

  if (status === "START_FAILED") {
    resetRecordingUiState(timestamp);
    processingStatusEl.textContent = details ? `Failed to start recording: ${details}` : "Failed to start recording. Check permissions and try again.";
  }
});

ipcRenderer.on("recording-levels", (_, levels) => {
  recorderSystemLevel = levels?.systemLevel || 0;
  recorderMicLevel = levels?.micLevel || 0;
  refreshDisplayedAudioLevels();
});

document.getElementById("output-file-path").addEventListener("click", async () => {
  const filePath = document.getElementById("output-file-path").textContent;
  if (!filePath || filePath === "Start recording to see the file path") return;
  try {
    await ipcRenderer.invoke("open-path", path.dirname(filePath));
  } catch (error) {
    processingStatusEl.textContent = `Could not open recording folder: ${error.message}`;
  }
});

document.getElementById("refresh-recordings").addEventListener("click", refreshRecordings);
recordingSelectEl.addEventListener("change", async () => {
  await updateRecordingMeta();
  await loadTranscriptForSelection();
});

document.getElementById("process-recording").addEventListener("click", async () => {
  const selectedPath = recordingSelectEl.value;
  const model = document.getElementById("model-select").value;

  if (!selectedPath) {
    setProcessing(false, "Select a recording first.");
    return;
  }

  setProcessing(true, "Uploading audio to Gemini...");

  try {
    const result = await ipcRenderer.invoke("process-recording", {
      filePath: selectedPath,
      model,
    });

    transcriptPath = result.transcriptPath;
    markdownEditorEl.value = result.markdown;
    renderPreview();
    updateSearchMatches();

    saveMarkdownEl.disabled = false;

    setProcessing(false, `Transcript ready: ${path.basename(transcriptPath)}`);
  } catch (error) {
    setProcessing(false, `Processing failed: ${error.message}`);
  }
});

exportMp3El.addEventListener("click", async () => {
  const selectedPath = recordingSelectEl.value;
  const shouldChunk = chunkMp3El.checked;

  if (!selectedPath) {
    setExporting(false, "Select a recording first.");
    return;
  }

  setExporting(true, shouldChunk ? "Exporting MP3 chunks..." : "Exporting MP3...");

  try {
    const result = await ipcRenderer.invoke("export-recording-mp3", {
      filePath: selectedPath,
      chunked: shouldChunk,
    });

    if (result.chunked) {
      setExporting(false, `MP3 chunks ready: ${result.fileCount} files in ${path.basename(result.outputDirectory)}`);
      await ipcRenderer.invoke("open-path", result.outputDirectory).catch(() => {});
      return;
    }

    setExporting(false, `MP3 ready: ${path.basename(result.outputPath)}`);
    await ipcRenderer.invoke("open-path", path.dirname(result.outputPath)).catch(() => {});
  } catch (error) {
    setExporting(false, `MP3 export failed: ${error.message}`);
  }
});

saveMarkdownEl.addEventListener("click", async () => {
  if (!transcriptPath) return;

  try {
    await ipcRenderer.invoke("save-markdown", {
      markdownPath: transcriptPath,
      content: markdownEditorEl.value,
    });

    processingStatusEl.textContent = `Saved ${path.basename(transcriptPath)}`;
  } catch (error) {
    processingStatusEl.textContent = `Save failed: ${error.message}`;
  }
});

searchInputEl.addEventListener("input", () => updateSearchMatches({ focusEditor: false }));
document.getElementById("search-next").addEventListener("click", gotoNextMatch);
document.getElementById("search-prev").addEventListener("click", gotoPrevMatch);
document.getElementById("replace-one").addEventListener("click", replaceCurrentMatch);
document.getElementById("replace-all").addEventListener("click", replaceAllMatches);

markdownEditorEl.addEventListener("input", () => {
  renderPreview();
  updateSearchMatches();
});

const init = async () => {
  try {
    const storagePaths = await ipcRenderer.invoke("get-storage-paths");
    selectedFolderPath = storagePaths.recordingsPath;
    transcriptsFolderPath = storagePaths.transcriptsPath;
    selectedFolderPathEl.textContent = selectedFolderPath;
    selectedTranscriptsPathEl.textContent = transcriptsFolderPath;
    openTranscriptFolderEl.disabled = false;

    recordingFilename = getDefaultMeetingFilename();
    recordingFilenameEl.value = recordingFilename;

    setRecordingToggleState();
    exportMp3El.disabled = true;
    await ensureMicrophonePromptOnLaunch();
    await refreshRecordings();
    await refreshMicrophones();
    renderPreview();
    updateSearchMatches();
  } catch (error) {
    processingStatusEl.textContent = `Initialization failed: ${error.message}`;
  }
};

window.addEventListener("beforeunload", () => {
  stopLiveMicMonitor().catch(() => {});
});

init();
