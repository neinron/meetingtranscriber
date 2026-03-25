const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const SETTINGS_FILE_NAME = "settings.json";

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
  };
};

const saveGeminiApiKey = (apiKey) => {
  const trimmedApiKey = String(apiKey || "").trim();
  const settings = readSettings();
  const nextSettings = {
    ...settings,
    geminiApiKey: trimmedApiKey,
  };

  writeSettings(nextSettings);
  process.env.GEMINI_API_KEY = trimmedApiKey;

  return getGeminiSettingsSummary();
};

module.exports = {
  getGeminiApiKey,
  getGeminiSettingsSummary,
  saveGeminiApiKey,
};
