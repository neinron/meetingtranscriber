const AUDIO_TOKENS_PER_SECOND = 32;
const ESTIMATED_PROMPT_TOKENS = 160;
const ESTIMATED_METADATA_PROMPT_TOKENS = 70;
const ESTIMATED_METADATA_OUTPUT_TOKENS = 80;
const ESTIMATED_WORDS_PER_MINUTE = 150;
const ESTIMATED_TOKENS_PER_WORD = 1.3;

const TRANSCRIPTION_MODELS = [
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    description: "Latest general-purpose Gemini preview model shown in the official audio understanding docs.",
    textInputUsdPerMillion: 0.1,
    audioInputUsdPerMillion: 0.7,
    textOutputUsdPerMillion: 0.4,
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    description: "Balanced speed and quality for audio transcription workloads.",
    textInputUsdPerMillion: 0.3,
    audioInputUsdPerMillion: 1.0,
    textOutputUsdPerMillion: 2.5,
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    description: "Lowest cost Gemini 2.5 model with audio input support.",
    textInputUsdPerMillion: 0.1,
    audioInputUsdPerMillion: 0.3,
    textOutputUsdPerMillion: 0.4,
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    description: "Highest quality Gemini 2.5 option for more complex post-processing.",
    textInputUsdPerMillion: 1.25,
    audioInputUsdPerMillion: 1.25,
    textOutputUsdPerMillion: 10.0,
  },
];

const DEFAULT_TRANSCRIPTION_MODEL = "gemini-3-flash-preview";
const METADATA_MODEL = "gemini-2.5-flash";

const getTranscriptionModels = () => TRANSCRIPTION_MODELS.map((model) => ({ ...model }));

const getModelById = (modelId) => TRANSCRIPTION_MODELS.find((model) => model.id === modelId) || TRANSCRIPTION_MODELS.find((model) => model.id === DEFAULT_TRANSCRIPTION_MODEL);

const estimateTranscriptTokens = (durationSeconds = 0) => {
  const minutes = Math.max(0, Number(durationSeconds) || 0) / 60;
  const estimatedWords = minutes * ESTIMATED_WORDS_PER_MINUTE;
  return Math.max(1, Math.round(estimatedWords * ESTIMATED_TOKENS_PER_WORD));
};

const estimateGeminiCost = ({ durationSeconds = 0, modelId = DEFAULT_TRANSCRIPTION_MODEL, eurPerUsd = null } = {}) => {
  const model = getModelById(modelId);
  const audioTokens = Math.max(1, Math.round((Number(durationSeconds) || 0) * AUDIO_TOKENS_PER_SECOND));
  const transcriptOutputTokens = estimateTranscriptTokens(durationSeconds);
  const metadataInputTokens = transcriptOutputTokens + ESTIMATED_METADATA_PROMPT_TOKENS;
  const metadataModel = getModelById(METADATA_MODEL);

  const firstCallInputUsd =
    (audioTokens / 1_000_000 * model.audioInputUsdPerMillion)
    + (ESTIMATED_PROMPT_TOKENS / 1_000_000 * model.textInputUsdPerMillion);
  const firstCallOutputUsd = transcriptOutputTokens / 1_000_000 * model.textOutputUsdPerMillion;
  const metadataInputUsd = metadataInputTokens / 1_000_000 * metadataModel.textInputUsdPerMillion;
  const metadataOutputUsd = ESTIMATED_METADATA_OUTPUT_TOKENS / 1_000_000 * metadataModel.textOutputUsdPerMillion;
  const estimatedUsd = firstCallInputUsd + firstCallOutputUsd + metadataInputUsd + metadataOutputUsd;

  return {
    modelId: model.id,
    metadataModelId: metadataModel.id,
    durationSeconds: Math.max(0, Number(durationSeconds) || 0),
    audioTokens,
    transcriptTokens: transcriptOutputTokens,
    estimatedUsd,
    estimatedEur: Number.isFinite(eurPerUsd) && eurPerUsd > 0 ? estimatedUsd * eurPerUsd : null,
    eurPerUsd: Number.isFinite(eurPerUsd) && eurPerUsd > 0 ? eurPerUsd : null,
  };
};

module.exports = {
  AUDIO_TOKENS_PER_SECOND,
  DEFAULT_TRANSCRIPTION_MODEL,
  METADATA_MODEL,
  estimateGeminiCost,
  getModelById,
  getTranscriptionModels,
};
