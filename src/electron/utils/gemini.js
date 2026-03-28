const fs = require("node:fs/promises");
const path = require("node:path");
const { getGeminiApiKey, getTranscriptionPrompt } = require("./settings");
const { DEFAULT_TRANSCRIPTION_MODEL, METADATA_MODEL } = require("./gemini-models");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const DIARIZATION_LINE_REGEX = /^\[(\d{2}:\d{2}:\d{2})\]\s+(Speaker\s+\d+):\s*(.*)$/;
const DESCRIPTION_PLACEHOLDER = "{description placeholder}";

const buildPrompt = () => getTranscriptionPrompt();

const extractTextFromGenerateContentPayload = (payload) => {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
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

const smoothDiarizedTranscript = (markdown) => {
  const lines = markdown.split("\n");
  const output = [];
  let pending = null;

  const flushPending = () => {
    if (!pending) return;
    output.push(`[${pending.timestamp}] ${pending.speaker}: ${pending.text.trim()}`);
    pending = null;
  };

  for (const line of lines) {
    const match = line.match(DIARIZATION_LINE_REGEX);
    if (!match) {
      flushPending();
      const plainLine = line.trim();
      if (plainLine) {
        output.push(plainLine);
      }
      continue;
    }

    const [, timestamp, speaker, text] = match;
    if (!pending) {
      pending = { timestamp, speaker, text: text.trim() };
      continue;
    }

    if (pending.speaker === speaker) {
      pending.text = `${pending.text} ${text.trim()}`.trim();
      continue;
    }

    flushPending();
    pending = { timestamp, speaker, text: text.trim() };
  }

  flushPending();
  return output.join("\n\n");
};

const getApiKey = () => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    const envPath = process.env.GEMINI_ENV_PATH || ".env";
    throw new Error(`Missing Gemini API key. Add it in the app settings or set GEMINI_API_KEY in ${envPath}.`);
  }

  return apiKey;
};

const startResumableUpload = async ({ apiKey, displayName, mimeType, byteLength }) => {
  const response = await fetch(`${GEMINI_API_BASE}/upload/v1beta/files?key=${apiKey}`, {
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

const uploadFileData = async ({ uploadUrl, buffer }) => {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(buffer.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: buffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini upload finalize failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  return payload.file;
};

const requestTranscript = async ({ apiKey, model, fileUri, mimeType }) => {
  const response = await fetch(`${GEMINI_API_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: buildPrompt() },
            {
              file_data: {
                file_uri: fileUri,
                mime_type: mimeType,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
      },
    }),
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
    throw new Error(
      reasons.length
        ? `Gemini transcript request returned no text (${reasons.join("; ")}).`
        : "Gemini transcript request returned no text."
    );
  }

  return extracted.text;
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

const requestMeetingMetadata = async ({ apiKey, transcriptText }) => {
  const response = await fetch(`${GEMINI_API_BASE}/v1beta/models/${METADATA_MODEL}:generateContent?key=${apiKey}`, {
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

  // Keep description to max 2 sentences if model returned more.
  const sentences = rawDescription.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [rawDescription];
  const description = sentences.slice(0, 2).join(" ").trim();

  return {
    title: rawTitle,
    description,
  };
};

const formatDateTimeForHeader = (date = new Date()) => {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
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

const processRecordingWithGemini = async ({ filePath, model = DEFAULT_TRANSCRIPTION_MODEL }) => {
  const apiKey = getApiKey();
  const audioBuffer = await fs.readFile(filePath);
  const fileStats = await fs.stat(filePath);
  const mimeType = "audio/flac";

  const uploadUrl = await startResumableUpload({
    apiKey,
    displayName: path.basename(filePath),
    mimeType,
    byteLength: audioBuffer.byteLength,
  });

  const uploadedFile = await uploadFileData({
    uploadUrl,
    buffer: audioBuffer,
  });

  try {
    const transcriptRaw = await requestTranscript({
      apiKey,
      model,
      fileUri: uploadedFile.uri,
      mimeType,
    });

    const transcript = smoothDiarizedTranscript(transcriptRaw).trim();
    const fileTitle = path.parse(filePath).name;
    const endDate = fileStats.mtime instanceof Date ? fileStats.mtime : new Date(fileStats.mtimeMs);
    const transcriptDurationSeconds = parseTranscriptDurationSeconds(transcript);
    const startDate = new Date(endDate.getTime() - (transcriptDurationSeconds * 1000));
    const dateLine = `Date: ${formatDateLabel(startDate)} | Start: ${formatTimeLabel(startDate)} | End: ${formatTimeLabel(endDate)}`;
    const template = buildMeetingTemplate({
      transcriptText: transcript,
      fileTitle,
      dateLine,
    });

    let metadata = {
      title: "Meeting",
      description: "Transcript generated. Review the notes and update the title if needed.",
    };

    try {
      metadata = await requestMeetingMetadata({
        apiKey,
        transcriptText: transcript,
      });
    } catch (error) {
      // Metadata is helpful, but a transcript without it is still usable.
      // eslint-disable-next-line no-console
      console.warn(`Gemini metadata generation failed: ${error.message}`);
    }

    return template.replace(DESCRIPTION_PLACEHOLDER, metadata.description);
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
