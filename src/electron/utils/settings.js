const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const SETTINGS_FILE_NAME = "settings.json";
const DEFAULT_APP_SESSION_STATE = {
  selectedRecordingId: "",
  lastPrimaryView: "setup",
};
const DEFAULT_TRANSCRIPTION_PROMPT = [
  "You are a literal audio transcription system.",
  "Transcribe only speech that is actually audible in the provided audio.",
  "Do not infer, summarize, paraphrase, complete, or invent content that is not clearly present.",
  "If speech is unclear, missing, overlapped, or inaudible, mark that portion as [inaudible] instead of guessing.",
  "If there is no intelligible speech for a stretch, do not fabricate dialogue for that section.",
  "Produce a diarized transcript as plain text lines.",
  "Requirements:",
  "1. Output transcript lines only. No headings.",
  "2. Transcript entries must follow this format: [HH:MM:SS] Speaker N: utterance",
  "3. Do not include markdown headings, summary, or action items.",
  "4. Do not include code fences.",
  "5. Infer distinct speakers and keep labels stable (Speaker 1, Speaker 2, etc.).",
  "6. If uncertain about a word, use [inaudible].",
  "7. Create a new transcript entry only when the speaker changes.",
  "8. Do not split one speaker into many short entries because of brief pauses.",
  "9. Keep long monologues as a single entry until another speaker starts.",
  "10. Do not write plausible-sounding meeting content unless it is directly supported by the audio.",
  "11. Preserve hesitations, partial phrases, and imperfect grammar when they are audible.",
  "12. If only one speaker is audible, keep a single stable speaker label instead of inventing others.",
].join("\n");

const getSettingsPath = () => path.join(app.getPath("userData"), SETTINGS_FILE_NAME);

const readSettings = () => {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeSettings = (nextSettings) => {
  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2));
  return settingsPath;
};

const updateSettings = (updater) => {
  const currentSettings = readSettings();
  const nextSettings = typeof updater === "function" ? updater(currentSettings) : currentSettings;
  writeSettings(nextSettings);
  return nextSettings;
};

const getGeminiApiKey = () => {
  const envValue = (process.env.GEMINI_API_KEY || "").trim();
  if (envValue) {
    return envValue;
  }

  const settings = readSettings();
  return typeof settings.geminiApiKey === "string" ? settings.geminiApiKey.trim() : "";
};

const getGeminiSettingsSummary = () => {
  const apiKey = getGeminiApiKey();
  const settingsPath = getSettingsPath();

  return {
    hasApiKey: Boolean(apiKey),
    source: (process.env.GEMINI_API_KEY || "").trim() ? "env" : "app",
    settingsPath,
    transcriptionPrompt: getTranscriptionPrompt(),
  };
};

const saveGeminiApiKey = (apiKey) => {
  const trimmedApiKey = String(apiKey || "").trim();
  updateSettings((settings) => ({
    ...settings,
    geminiApiKey: trimmedApiKey,
  }));
  process.env.GEMINI_API_KEY = trimmedApiKey;

  return getGeminiSettingsSummary();
};

const getTranscriptionPrompt = () => {
  const settings = readSettings();
  const prompt = typeof settings.transcriptionPrompt === "string" ? settings.transcriptionPrompt.trim() : "";
  return prompt || DEFAULT_TRANSCRIPTION_PROMPT;
};

const saveTranscriptionPrompt = (prompt) => {
  const nextPrompt = typeof prompt === "string" && prompt.trim() ? prompt.trim() : DEFAULT_TRANSCRIPTION_PROMPT;
  updateSettings((settings) => ({
    ...settings,
    transcriptionPrompt: nextPrompt,
  }));

  return getTranscriptionPrompt();
};

const getThemeMode = () => {
  const settings = readSettings();
  const themeMode = typeof settings.themeMode === "string" ? settings.themeMode.trim().toLowerCase() : "";
  return ["light", "dark", "system"].includes(themeMode) ? themeMode : "system";
};

const saveThemeMode = (themeMode) => {
  const normalizedThemeMode = typeof themeMode === "string" ? themeMode.trim().toLowerCase() : "";
  const nextThemeMode = ["light", "dark", "system"].includes(normalizedThemeMode) ? normalizedThemeMode : "system";

  updateSettings((settings) => ({
    ...settings,
    themeMode: nextThemeMode,
  }));

  return getThemeMode();
};

const getUiDisclosureState = () => {
  const settings = readSettings();
  return settings?.uiDisclosureState && typeof settings.uiDisclosureState === "object" ? settings.uiDisclosureState : {};
};

const getAppSessionState = () => {
  const settings = readSettings();
  const sessionState = settings?.appSessionState;
  if (!sessionState || typeof sessionState !== "object") {
    return { ...DEFAULT_APP_SESSION_STATE };
  }

  return {
    selectedRecordingId: typeof sessionState.selectedRecordingId === "string" ? sessionState.selectedRecordingId : "",
    lastPrimaryView: ["setup", "review", "prompt"].includes(sessionState.lastPrimaryView)
      ? sessionState.lastPrimaryView
      : "setup",
  };
};

const saveUiDisclosureState = (disclosureState) => {
  updateSettings((settings) => ({
    ...settings,
    uiDisclosureState: {
      ...(settings?.uiDisclosureState && typeof settings.uiDisclosureState === "object" ? settings.uiDisclosureState : {}),
      ...(disclosureState && typeof disclosureState === "object" ? disclosureState : {}),
    },
  }));

  return getUiDisclosureState();
};

const saveAppSessionState = (sessionState) => {
  updateSettings((settings) => ({
    ...settings,
    appSessionState: {
      ...getAppSessionState(),
      ...(sessionState && typeof sessionState === "object" ? sessionState : {}),
    },
  }));

  return getAppSessionState();
};

const getCachedExchangeRate = () => {
  const settings = readSettings();
  const cache = settings?.cachedExchangeRate;
  if (!cache || typeof cache !== "object") {
    return null;
  }

  const eurPerUsd = Number(cache.eurPerUsd);
  if (!Number.isFinite(eurPerUsd) || eurPerUsd <= 0) {
    return null;
  }

  return {
    eurPerUsd,
    usdPerEur: Number(cache.usdPerEur),
    referenceDate: cache.referenceDate || "",
    fetchedAt: cache.fetchedAt || "",
    source: cache.source || "cache",
  };
};

const saveCachedExchangeRate = ({ eurPerUsd, usdPerEur, referenceDate, source }) => {
  const normalizedEurPerUsd = Number(eurPerUsd);
  const normalizedUsdPerEur = Number(usdPerEur);

  if (!Number.isFinite(normalizedEurPerUsd) || normalizedEurPerUsd <= 0) {
    return getCachedExchangeRate();
  }

  updateSettings((settings) => ({
    ...settings,
    cachedExchangeRate: {
      eurPerUsd: normalizedEurPerUsd,
      usdPerEur: Number.isFinite(normalizedUsdPerEur) && normalizedUsdPerEur > 0 ? normalizedUsdPerEur : 1 / normalizedEurPerUsd,
      referenceDate: referenceDate || "",
      fetchedAt: new Date().toISOString(),
      source: source || "ecb",
    },
  }));

  return getCachedExchangeRate();
};

module.exports = {
  DEFAULT_TRANSCRIPTION_PROMPT,
  getCachedExchangeRate,
  getGeminiApiKey,
  getGeminiSettingsSummary,
  getAppSessionState,
  getThemeMode,
  getTranscriptionPrompt,
  getUiDisclosureState,
  saveAppSessionState,
  saveGeminiApiKey,
  saveCachedExchangeRate,
  saveTranscriptionPrompt,
  saveThemeMode,
  saveUiDisclosureState,
};
