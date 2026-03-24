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
  setAudioLevels(0, 0);
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
    .replace(/\s+/g, " ")
    .trim();
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
          id: rawName || device.deviceId,
          name: normalizedName,
          isDefault: device.deviceId === "default",
        };

        if (!existing) {
          dedupedDevices.set(dedupeKey, nextDevice);
          return;
        }

        dedupedDevices.set(dedupeKey, {
          id: existing.isDefault ? existing.id : nextDevice.id,
          name: existing.name,
          isDefault: existing.isDefault || nextDevice.isDefault,
        });
      });

    return Array.from(dedupedDevices.values());
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
};

const refreshMicrophones = async () => {
  try {
    let devices = await getRendererMicrophones();
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
      option.textContent = device.isDefault ? `${device.name} (Default)` : device.name;
      microphoneSelectEl.appendChild(option);
    });

    if (selectedMicDeviceId && devices.some((device) => device.id === selectedMicDeviceId)) {
      microphoneSelectEl.value = selectedMicDeviceId;
      return;
    }

    const defaultDevice = devices.find((device) => device.isDefault);
    selectedMicDeviceId = defaultDevice?.id || "";
    microphoneSelectEl.value = selectedMicDeviceId;
  } catch (error) {
    microphoneSelectEl.innerHTML = '<option value="">No microphone</option>';
    selectedMicDeviceId = "";
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
    return;
  }

  const modified = new Date(selected.modifiedAt).toLocaleString();
  const created = selected.createdAt ? new Date(selected.createdAt).toLocaleString() : modified;
  recordingMetaEl.textContent = `Size: ${formatSize(selected.sizeBytes)} • Created: ${created}`;

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
      transcriptPath = null;
      markdownEditorEl.value = "";
      renderPreview();
      saveMarkdownEl.disabled = true;
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
    const result = await ipcRenderer.invoke("request-microphone-permission");
    if (result?.ok) {
      processingStatusEl.textContent = "Microphone permission granted.";
      await refreshMicrophones();
      return;
    }
    processingStatusEl.textContent = `Microphone permission status: ${result?.status || "unknown"}`;
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
});

recordingToggleEl.addEventListener("click", () => {
  if (isPendingStart || isPendingStop) return;

  if (!isRecording) {
    isPendingStart = true;
    setRecordingToggleState();

    ipcRenderer.send("start-recording", {
      filename: recordingFilename,
      micDeviceId: selectedMicDeviceId || null,
    });

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
  setAudioLevels(levels?.systemLevel || 0, levels?.micLevel || 0);
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
      return;
    }

    setExporting(false, `MP3 ready: ${path.basename(result.outputPath)}`);
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
    await refreshRecordings();
    await refreshMicrophones();
    renderPreview();
    updateSearchMatches();
  } catch (error) {
    processingStatusEl.textContent = `Initialization failed: ${error.message}`;
  }
};

init();
