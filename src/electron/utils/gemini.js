const fs = require("node:fs/promises");
const path = require("node:path");
const { getGeminiApiKey, getTranscriptionPrompt } = require("./settings");
const { DEFAULT_TRANSCRIPTION_MODEL, METADATA_MODEL } = require("./gemini-models");
const { getRecordingAnalysis } = require("./recording-analysis");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const DIARIZATION_LINE_REGEX = /^\[(\d{2}:\d{2}:\d{2})\]\s+(Speaker\s+\d+):\s*(.*)$/;
const DESCRIPTION_PLACEHOLDER = "{description placeholder}";
const FILE_READY_POLL_INTERVAL_MS = 5000;
const FILE_READY_TIMEOUT_MS = 20 * 60 * 1000;
const TRANSCRIPT_RETRY_LIMIT = 4;
const TRANSCRIPT_RETRY_BASE_DELAY_MS = 3000;
const UPLOAD_START_TIMEOUT_MS = 60 * 1000;
const UPLOAD_FINALIZE_TIMEOUT_MS = 15 * 60 * 1000;
const FILE_STATUS_TIMEOUT_MS = 60 * 1000;
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 18 * 60 * 1000;
const METADATA_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const SUMMARY_LIKE_PATTERNS = [
  /^#/m,
  /^\s*summary[:\s]/im,
  /^\s*action items?[:\s]/im,
  /^\s*key takeaways?[:\s]/im,
  /^\s*description[:\s]/im,
  /\bthe meeting (discussed|covered|focused on)\b/i,
  /\bparticipants (discussed|agreed|decided)\b/i,
  /\bthe conversation (covered|focused on)\b/i,
];
const TRANSCRIPT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          timestamp: {
            type: "STRING",
            description: "Start timestamp from the beginning of the provided audio in MM:SS or HH:MM:SS format.",
          },
          speaker: {
            type: "STRING",
            description: "Stable speaker label such as Speaker 1, Speaker 2, etc.",
          },
          content: {
            type: "STRING",
            description: "Literal transcribed speech for the segment. Use [inaudible] instead of guessing unclear speech.",
          },
        },
        required: ["timestamp", "speaker", "content"],
      },
    },
  },
  required: ["segments"],
};

const buildPrompt = () => getTranscriptionPrompt();

const createGeminiNoTextError = (message, context = {}) => {
  const error = new Error(message);
  error.code = "GEMINI_NO_TEXT";
  Object.assign(error, context);
  return error;
};

const createTranscriptionAbortedError = () => {
  const error = new Error("Transcription stopped.");
  error.code = "TRANSCRIPTION_ABORTED";
  return error;
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    throw createTranscriptionAbortedError();
  }
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  throwIfAborted(signal);
  const timeout = setTimeout(() => {
    cleanup();
    resolve();
  }, ms);

  const onAbort = () => {
    cleanup();
    reject(createTranscriptionAbortedError());
  };

  const cleanup = () => {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", onAbort);
  };

  signal?.addEventListener?.("abort", onAbort, { once: true });
});

const combineSignals = (...signals) => {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  signals.filter(Boolean).forEach((signal) => {
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });

  return controller;
};

const withTimeoutSignal = async ({ signal, timeoutMs, operation }) => {
  const timeoutController = new AbortController();
  const combinedController = combineSignals(signal, timeoutController.signal);
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    return await operation(combinedController.signal);
  } catch (error) {
    if (!signal?.aborted && timeoutController.signal.aborted) {
      const timeoutError = new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      timeoutError.code = "GEMINI_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const withAbortHandling = async (operation, signal) => {
  try {
    throwIfAborted(signal);
    return await operation();
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) {
      throw createTranscriptionAbortedError();
    }
    throw error;
  }
};

const collectTextFromValue = (value) => {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectTextFromValue);
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, nestedValue]) => {
    if (key === "text" && typeof nestedValue === "string") {
      return [nestedValue];
    }
    return collectTextFromValue(nestedValue);
  });
};

const extractTextFromGenerateContentPayload = (payload) => {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts
      .flatMap((part) => collectTextFromValue(part))
      .join("")
      .trim();

    if (text) {
      return {
        text,
        finishReason: candidate?.finishReason || "",
      };
    }
  }

  const finishReason = candidates.find((candidate) => typeof candidate?.finishReason === "string")?.finishReason || "";
  const blockReason = payload?.promptFeedback?.blockReason || "";
  const safetyRatings = Array.isArray(payload?.promptFeedback?.safetyRatings)
    ? payload.promptFeedback.safetyRatings
        .map((rating) => [rating?.category, rating?.probability].filter(Boolean).join(": "))
        .filter(Boolean)
        .join(", ")
    : "";

  return {
    text: "",
    finishReason,
    blockReason,
    safetyRatings,
  };
};

const getApiKey = () => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    const envPath = process.env.GEMINI_ENV_PATH || ".env";
    throw new Error(`Missing Gemini API key. Add it in the app settings or set GEMINI_API_KEY in ${envPath}.`);
  }

  return apiKey;
};

const startResumableUpload = async ({ apiKey, displayName, mimeType, byteLength, signal }) => {
  const response = await withTimeoutSignal({
    signal,
    timeoutMs: UPLOAD_START_TIMEOUT_MS,
    operation: (requestSignal) => withAbortHandling(() => fetch(`${GEMINI_API_BASE}/upload/v1beta/files?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(byteLength),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      body: JSON.stringify({
        file: {
          display_name: displayName,
        },
      }),
      signal: requestSignal,
    }), signal),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini upload start failed: ${response.status} ${errorText}`);
  }

  const uploadUrl = response.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini upload start failed: missing upload URL.");
  }

  return uploadUrl;
};

const uploadFileData = async ({ uploadUrl, buffer, signal }) => {
  const response = await withTimeoutSignal({
    signal,
    timeoutMs: UPLOAD_FINALIZE_TIMEOUT_MS,
    operation: (requestSignal) => withAbortHandling(() => fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(buffer.byteLength),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: buffer,
      signal: requestSignal,
    }), signal),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini upload finalize failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  return payload.file;
};

const getUploadedFileStatus = async ({ apiKey, fileName, signal }) => {
  const response = await withTimeoutSignal({
    signal,
    timeoutMs: FILE_STATUS_TIMEOUT_MS,
    operation: (requestSignal) => withAbortHandling(() => fetch(`${GEMINI_API_BASE}/v1beta/${fileName}?key=${apiKey}`, {
      method: "GET",
      signal: requestSignal,
    }), signal),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini file status request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  return payload;
};

const getFileStateName = (filePayload) => {
  const rawState = filePayload?.state;
  if (typeof rawState === "string") {
    return rawState.toUpperCase();
  }
  if (rawState && typeof rawState?.name === "string") {
    return rawState.name.toUpperCase();
  }
  return "";
};

const waitForUploadedFileReady = async ({ apiKey, fileName, signal, onProgress = null }) => {
  const startedAt = Date.now();

  while (true) {
    throwIfAborted(signal);
    const payload = await getUploadedFileStatus({
      apiKey,
      fileName,
      signal,
    });
    const state = getFileStateName(payload);

    if (!state || state === "ACTIVE") {
      return payload.file || payload;
    }

    if (state === "FAILED" || state === "ERROR") {
      const failureReason = payload?.file?.error?.message || payload?.error?.message || "Gemini file processing failed.";
      throw new Error(failureReason);
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= FILE_READY_TIMEOUT_MS) {
      throw new Error(`Gemini file processing timed out after ${Math.round(FILE_READY_TIMEOUT_MS / 60000)} minutes.`);
    }

    if (typeof onProgress === "function") {
      const elapsedSeconds = Math.max(1, Math.round(elapsedMs / 1000));
      await onProgress(`Processing uploaded audio in Gemini... ${elapsedSeconds}s elapsed`);
    }

    await sleep(FILE_READY_POLL_INTERVAL_MS, signal);
  }
};

const isRetryableTranscriptError = (error) => {
  const message = String(error?.message || "");
  return [
    "429",
    "500",
    "502",
    "503",
    "504",
    "RESOURCE_EXHAUSTED",
    "UNAVAILABLE",
    "DEADLINE_EXCEEDED",
    "INTERNAL",
    "file is not in an active state",
    "not in an active state",
    "processing",
    "temporarily unavailable",
    "JSON",
  ].some((token) => message.includes(token));
};

const formatTimestamp = (seconds) => {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const hh = String(Math.floor(safeSeconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((safeSeconds % 3600) / 60)).padStart(2, "0");
  const ss = String(safeSeconds % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

const parseFlexibleTimestampSeconds = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }

  const normalized = String(value || "").trim().replace(",", ".");
  if (!normalized) {
    return null;
  }

  if (/^\d+(\.\d+)?$/u.test(normalized)) {
    return Number(normalized);
  }

  const parts = normalized.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }

  if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  }

  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }

  return null;
};

const getStableSpeakerMapper = () => {
  const speakerMap = new Map();

  return (rawSpeaker) => {
    const key = String(rawSpeaker || "").trim() || "Speaker 1";
    if (!speakerMap.has(key)) {
      speakerMap.set(key, `Speaker ${speakerMap.size + 1}`);
    }
    return speakerMap.get(key);
  };
};

const buildStructuredTranscriptPrompt = () => [
  buildPrompt(),
  "",
  "Return the transcript strictly as JSON matching the provided response schema.",
  "Output only the JSON object.",
  "Schema rules:",
  "1. segments[].timestamp must be the segment start time from the beginning of the provided audio.",
  "2. Use MM:SS or HH:MM:SS timestamps.",
  "3. segments[].speaker must be a stable label such as Speaker 1, Speaker 2, etc.",
  "4. segments[].content must contain only audible speech from the audio.",
  "5. Do not add a summary, headings, markdown, or extra keys.",
  "6. If speech is unclear, use [inaudible] instead of guessing.",
].join("\n");

const parseStructuredTranscriptPayload = (text) => {
  const normalized = String(text || "").trim();
  if (!normalized) {
    throw createGeminiNoTextError("Gemini transcript request returned no text.");
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  const jsonSlice = firstBrace >= 0 && lastBrace > firstBrace
    ? normalized.slice(firstBrace, lastBrace + 1)
    : normalized;

  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (error) {
    const jsonError = new Error(`Gemini returned invalid JSON transcript output: ${error.message}`);
    jsonError.code = "GEMINI_INVALID_JSON";
    throw jsonError;
  }

  const rawSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const toStableSpeaker = getStableSpeakerMapper();
  const normalizedSegments = [];

  for (const rawSegment of rawSegments) {
    const timestampSeconds = parseFlexibleTimestampSeconds(rawSegment?.timestamp);
    const content = String(rawSegment?.content || "").trim();
    if (!Number.isFinite(timestampSeconds) || !content) {
      continue;
    }

    normalizedSegments.push({
      timestampSeconds,
      timestamp: formatTimestamp(timestampSeconds),
      speaker: toStableSpeaker(rawSegment?.speaker),
      content,
    });
  }

  normalizedSegments.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  return normalizedSegments;
};

const mergeTranscriptSegments = (segments) => {
  const merged = [];

  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && previous.speaker === segment.speaker
      && segment.timestampSeconds >= previous.timestampSeconds
      && (segment.timestampSeconds - previous.timestampSeconds) <= 8
    ) {
      previous.content = `${previous.content} ${segment.content}`.trim();
      continue;
    }

    merged.push({ ...segment });
  }

  return merged;
};

const segmentsToTranscriptText = (segments) =>
  mergeTranscriptSegments(segments)
    .map((segment) => `[${segment.timestamp}] ${segment.speaker}: ${segment.content}`)
    .join("\n\n")
    .trim();

const requestStructuredTranscript = async ({ apiKey, model, fileUri, mimeType, signal }) => {
  const response = await withTimeoutSignal({
    signal,
    timeoutMs: TRANSCRIPT_REQUEST_TIMEOUT_MS,
    operation: (requestSignal) => withAbortHandling(() => fetch(`${GEMINI_API_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                file_data: {
                  file_uri: fileUri,
                  mime_type: mimeType,
                },
              },
              { text: buildStructuredTranscriptPrompt() },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
        },
      }),
      signal: requestSignal,
    }), signal),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini transcript request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const extracted = extractTextFromGenerateContentPayload(payload);

  if (!extracted.text) {
    const reasons = [
      extracted.blockReason ? `block reason: ${extracted.blockReason}` : "",
      extracted.finishReason ? `finish reason: ${extracted.finishReason}` : "",
      extracted.safetyRatings ? `safety: ${extracted.safetyRatings}` : "",
    ].filter(Boolean);
    throw createGeminiNoTextError(
      reasons.length
        ? `Gemini transcript request returned no text (${reasons.join("; ")}).`
        : "Gemini transcript request returned no text.",
      {
        model,
        finishReason: extracted.finishReason || "",
        blockReason: extracted.blockReason || "",
      }
    );
  }

  return parseStructuredTranscriptPayload(extracted.text);
};

const requestTranscriptWithRetry = async ({
  apiKey,
  model,
  fileUri,
  mimeType,
  signal,
  onProgress = null,
}) => {
  let attempt = 0;

  while (attempt < TRANSCRIPT_RETRY_LIMIT) {
    throwIfAborted(signal);
    attempt += 1;

    try {
      if (typeof onProgress === "function") {
        await onProgress(
          attempt === 1
            ? "Waiting for Gemini transcript..."
            : `Retrying Gemini transcript... attempt ${attempt}/${TRANSCRIPT_RETRY_LIMIT}`
        );
      }

      return await requestStructuredTranscript({
        apiKey,
        model,
        fileUri,
        mimeType,
        signal,
      });
    } catch (error) {
      if (error?.code === "TRANSCRIPTION_ABORTED" || error?.code === "GEMINI_NO_TEXT") {
        throw error;
      }
      if (!isRetryableTranscriptError(error) || attempt >= TRANSCRIPT_RETRY_LIMIT) {
        throw error;
      }

      const delayMs = TRANSCRIPT_RETRY_BASE_DELAY_MS * attempt;
      if (typeof onProgress === "function") {
        await onProgress(`Gemini is still preparing the transcript source. Retrying in ${Math.round(delayMs / 1000)}s...`);
      }
      await sleep(delayMs, signal);
    }
  }

  throw new Error("Gemini transcript request exhausted all retries.");
};

const buildMetadataPrompt = (transcriptText) => [
  "You generate concise meeting metadata.",
  "Given the transcript below, output exactly two lines:",
  "TITLE: <short, specific meeting title>",
  "DESCRIPTION: <max 2 sentences summary of intent/outcome>",
  "Rules:",
  "1. DESCRIPTION must be at most 2 sentences.",
  "2. Do not include markdown.",
  "3. Do not add extra lines.",
  "",
  "Transcript:",
  transcriptText,
].join("\n");

const requestMeetingMetadata = async ({ apiKey, transcriptText, signal }) => {
  const response = await withTimeoutSignal({
    signal,
    timeoutMs: METADATA_REQUEST_TIMEOUT_MS,
    operation: (requestSignal) => withAbortHandling(() => fetch(`${GEMINI_API_BASE}/v1beta/models/${METADATA_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: buildMetadataPrompt(transcriptText) }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
      signal: requestSignal,
    }), signal),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini metadata request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const extracted = extractTextFromGenerateContentPayload(payload);
  const text = extracted.text.trim();

  if (!text) {
    const reasons = [
      extracted.blockReason ? `block reason: ${extracted.blockReason}` : "",
      extracted.finishReason ? `finish reason: ${extracted.finishReason}` : "",
    ].filter(Boolean);
    throw new Error(
      reasons.length
        ? `Gemini metadata request returned no text (${reasons.join("; ")}).`
        : "Gemini metadata request returned no text."
    );
  }

  const titleMatch = text.match(/TITLE:\s*(.+)/i);
  const descriptionMatch = text.match(/DESCRIPTION:\s*([\s\S]+)/i);

  const rawTitle = titleMatch?.[1]?.trim() || "Meeting";
  const rawDescription = descriptionMatch?.[1]?.trim() || "Discussion summary unavailable.";
  const sentences = rawDescription.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [rawDescription];
  const description = sentences.slice(0, 2).join(" ").trim();

  return {
    title: rawTitle,
    description,
  };
};

const formatDateLabel = (date = new Date()) => {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}.${mm}.${yyyy}`;
};

const formatTimeLabel = (date = new Date()) => {
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${min}`;
};

const parseTranscriptDurationSeconds = (transcriptText) => {
  const matches = Array.from(transcriptText.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\]/g));
  if (!matches.length) {
    return 0;
  }

  return Math.max(...matches.map((match) => {
    const [, hh, mm, ss] = match;
    return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
  }));
};

const countWords = (value) => {
  const matches = String(value || "").match(/[A-Za-z0-9][A-Za-z0-9'-]*/gu);
  return Array.isArray(matches) ? matches.length : 0;
};

const toTimestampSeconds = (timestamp) => {
  const match = String(timestamp || "").match(/^(\d{2}):(\d{2}):(\d{2})$/u);
  if (!match) {
    return null;
  }
  const [, hh, mm, ss] = match;
  return (Number(hh) * 3600) + (Number(mm) * 60) + Number(ss);
};

const validateTranscript = ({ transcriptText, audioDurationSeconds }) => {
  const normalizedTranscriptText = String(transcriptText || "").trim();
  const qualityFlags = [];
  const blockingFlags = [];
  const lines = normalizedTranscriptText
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  const diarizedEntries = [];
  let previousTimestamp = -1;
  let plainLineCount = 0;

  if (!normalizedTranscriptText) {
    return {
      status: "error",
      qualityFlags: ["empty_transcript"],
      metrics: {
        audioDurationSeconds: Number.isFinite(audioDurationSeconds) ? audioDurationSeconds : 0,
        transcriptDurationSeconds: 0,
        diarizedLineCount: 0,
        plainLineCount: 0,
        wordsPerMinute: 0,
      },
    };
  }

  for (const line of lines) {
    const match = line.match(DIARIZATION_LINE_REGEX);
    if (!match) {
      plainLineCount += 1;
      continue;
    }

    const [, timestamp, speaker, text] = match;
    const timestampSeconds = toTimestampSeconds(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      qualityFlags.push("invalid_timestamp");
      continue;
    }
    if (timestampSeconds < previousTimestamp) {
      qualityFlags.push("timestamps_non_monotonic");
    }
    previousTimestamp = timestampSeconds;
    diarizedEntries.push({
      timestamp,
      timestampSeconds,
      speaker,
      text: text.trim(),
    });
  }

  if (!diarizedEntries.length) {
    qualityFlags.push("missing_diarized_lines");
  }

  if (plainLineCount > Math.max(2, Math.ceil(lines.length * 0.25))) {
    qualityFlags.push("mixed_format_output");
  }

  if (SUMMARY_LIKE_PATTERNS.some((pattern) => pattern.test(transcriptText))) {
    qualityFlags.push("summary_like_output");
  }

  const transcriptDurationSeconds = diarizedEntries.length
    ? diarizedEntries[diarizedEntries.length - 1].timestampSeconds
    : 0;
  const effectiveAudioDuration = Number.isFinite(audioDurationSeconds) && audioDurationSeconds > 0
    ? audioDurationSeconds
    : transcriptDurationSeconds;

  if (effectiveAudioDuration >= 90 && transcriptDurationSeconds > 0) {
    const coverageRatio = transcriptDurationSeconds / effectiveAudioDuration;
    if (coverageRatio < 0.35) {
      qualityFlags.push("coverage_too_low");
    }
    if (coverageRatio > 1.2) {
      qualityFlags.push("coverage_too_high");
    }
  }

  const spokenWordCount = diarizedEntries.reduce((total, entry) => total + countWords(entry.text), 0);
  const totalWordCount = countWords(normalizedTranscriptText);
  const effectiveMinutes = Math.max(1 / 60, effectiveAudioDuration / 60);
  const wordsPerMinute = Math.max(spokenWordCount, totalWordCount) / effectiveMinutes;

  if (wordsPerMinute > 260) {
    qualityFlags.push("density_too_high");
  }
  if (effectiveAudioDuration >= 300 && wordsPerMinute < 8) {
    qualityFlags.push("density_too_low");
  }

  if (effectiveAudioDuration >= 300 && diarizedEntries.length < 2) {
    qualityFlags.push("too_few_transcript_segments");
  }

  const dedupedBlockingFlags = Array.from(new Set(blockingFlags));
  const dedupedQualityFlags = Array.from(new Set(qualityFlags.filter((flag) => !dedupedBlockingFlags.includes(flag))));
  const status = dedupedBlockingFlags.length
    ? "error"
    : (dedupedQualityFlags.length ? "needs_review" : "ready");

  return {
    status,
    qualityFlags: [...dedupedBlockingFlags, ...dedupedQualityFlags],
    metrics: {
      audioDurationSeconds: effectiveAudioDuration,
      transcriptDurationSeconds,
      diarizedLineCount: diarizedEntries.length,
      plainLineCount,
      wordsPerMinute,
    },
  };
};

const buildMeetingTemplate = ({ transcriptText, fileTitle, dateLine }) => {
  return [
    `# ${fileTitle}`,
    dateLine,
    "",
    DESCRIPTION_PLACEHOLDER,
    "",
    "## Transcript",
    transcriptText.trim(),
  ].join("\n");
};

const deleteUploadedFile = async ({ apiKey, fileName }) => {
  if (!fileName) return;

  await fetch(`${GEMINI_API_BASE}/v1beta/${fileName}?key=${apiKey}`, {
    method: "DELETE",
  }).catch(() => {
    // Non-fatal cleanup failure.
  });
};

const processRecordingWithGemini = async ({ filePath, model = DEFAULT_TRANSCRIPTION_MODEL, onProgress = null, signal = null }) => {
  const emitProgress = async (detail) => {
    if (typeof onProgress !== "function" || !detail) {
      return;
    }
    await onProgress(detail);
  };

  const apiKey = getApiKey();
  throwIfAborted(signal);
  await emitProgress("Reading audio...");
  const audioBuffer = await fs.readFile(filePath);
  const fileStats = await fs.stat(filePath);
  const recordingAnalysis = await getRecordingAnalysis(filePath).catch(() => null);
  const mimeType = "audio/flac";

  throwIfAborted(signal);
  await emitProgress("Starting upload...");
  const uploadUrl = await startResumableUpload({
    apiKey,
    displayName: path.basename(filePath),
    mimeType,
    byteLength: audioBuffer.byteLength,
    signal,
  });

  throwIfAborted(signal);
  await emitProgress("Uploading audio...");
  const uploadedFile = await uploadFileData({
    uploadUrl,
    buffer: audioBuffer,
    signal,
  });

  throwIfAborted(signal);
  await emitProgress("Waiting for Gemini to prepare the uploaded audio...");
  const readyFile = await waitForUploadedFileReady({
    apiKey,
    fileName: uploadedFile.name,
    signal,
    onProgress: emitProgress,
  });
  const activeFileUri = readyFile?.uri || uploadedFile.uri;
  const activeMimeType = readyFile?.mimeType || uploadedFile.mimeType || mimeType;

  try {
    let structuredSegments;
    try {
      throwIfAborted(signal);
      structuredSegments = await requestTranscriptWithRetry({
        apiKey,
        model,
        fileUri: activeFileUri,
        mimeType: activeMimeType,
        onProgress: emitProgress,
        signal,
      });
    } catch (error) {
      if (error?.code !== "GEMINI_NO_TEXT" || model === DEFAULT_TRANSCRIPTION_MODEL) {
        throw error;
      }

      await emitProgress("Retrying transcript with fallback model...");
      structuredSegments = await requestTranscriptWithRetry({
        apiKey,
        model: DEFAULT_TRANSCRIPTION_MODEL,
        fileUri: activeFileUri,
        mimeType: activeMimeType,
        onProgress: emitProgress,
        signal,
      });
    }

    throwIfAborted(signal);
    const transcript = segmentsToTranscriptText(structuredSegments);
    await emitProgress("Validating transcript...");
    const validation = validateTranscript({
      transcriptText: transcript,
      audioDurationSeconds: recordingAnalysis?.durationSeconds || 0,
    });
    const fileTitle = path.parse(filePath).name;
    const endDate = fileStats.mtime instanceof Date ? fileStats.mtime : new Date(fileStats.mtimeMs);
    const transcriptDurationSeconds = parseTranscriptDurationSeconds(transcript);
    const effectiveDurationSeconds = Number.isFinite(recordingAnalysis?.durationSeconds) && recordingAnalysis.durationSeconds > 0
      ? recordingAnalysis.durationSeconds
      : transcriptDurationSeconds;
    const startDate = new Date(endDate.getTime() - (effectiveDurationSeconds * 1000));
    const dateLine = `Date: ${formatDateLabel(startDate)} | Start: ${formatTimeLabel(startDate)} | End: ${formatTimeLabel(endDate)}`;

    if (validation.status === "error") {
      const validationError = new Error(`Transcript validation failed: ${validation.qualityFlags.join(", ") || "unknown validation error"}`);
      validationError.code = "TRANSCRIPT_VALIDATION_FAILED";
      validationError.qualityFlags = validation.qualityFlags;
      validationError.validation = validation;
      throw validationError;
    }

    let metadata = {
      title: "Meeting",
      description: "Transcript generated. Review the notes and update the title if needed.",
    };

    if (validation.status === "ready") {
      try {
        throwIfAborted(signal);
        await emitProgress("Generating meeting summary...");
        metadata = await requestMeetingMetadata({
          apiKey,
          transcriptText: transcript,
          signal,
        });
      } catch (error) {
        if (error?.code === "TRANSCRIPTION_ABORTED") {
          throw error;
        }
        // eslint-disable-next-line no-console
        console.warn(`Gemini metadata generation failed: ${error.message}`);
      }
    } else {
      metadata = {
        title: "Transcript Needs Review",
        description: "Transcript quality needs review. Verify it against the source audio before relying on it.",
      };
    }

    throwIfAborted(signal);
    await emitProgress("Finalizing transcript...");
    const markdown = buildMeetingTemplate({
      transcriptText: transcript,
      fileTitle,
      dateLine,
    }).replace(DESCRIPTION_PLACEHOLDER, metadata.description);

    return {
      markdown,
      transcript,
      status: validation.status,
      qualityFlags: validation.qualityFlags,
      validation,
      metadata,
    };
  } finally {
    await deleteUploadedFile({
      apiKey,
      fileName: uploadedFile.name,
    });
  }
};

module.exports = {
  processRecordingWithGemini,
};
