const fs = require("node:fs/promises");
const path = require("node:path");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash";
const METADATA_MODEL = "gemini-2.5-flash";
const DIARIZATION_LINE_REGEX = /^\[(\d{2}:\d{2}:\d{2})\]\s+(Speaker\s+\d+):\s*(.*)$/;
const TITLE_PLACEHOLDER = "{title placeholder}";
const DESCRIPTION_PLACEHOLDER = "{description placeholder}";

const buildPrompt = () => [
  "You are a precise meeting transcription assistant.",
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
].join("\n");

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
      output.push(line);
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
  return output.join("\n");
};

const getApiKey = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const envPath = process.env.GEMINI_ENV_PATH || ".env";
    throw new Error(`Missing GEMINI_API_KEY. Set it in ${envPath} and restart the app.`);
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
  const text = payload?.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;

  if (!text) {
    throw new Error("Gemini transcript request returned no text.");
  }

  return text;
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
  const text = payload?.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text?.trim();

  if (!text) {
    throw new Error("Gemini metadata request returned no text.");
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

const buildMeetingTemplate = ({ transcriptText, dateTimeLabel }) => {
  return [
    `# Meeting Notes - ${dateTimeLabel}`,
    `## ${TITLE_PLACEHOLDER}`,
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

const processRecordingWithGemini = async ({ filePath, model = DEFAULT_MODEL }) => {
  const apiKey = getApiKey();
  const audioBuffer = await fs.readFile(filePath);
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
    const template = buildMeetingTemplate({
      transcriptText: transcript,
      dateTimeLabel: formatDateTimeForHeader(new Date()),
    });

    const metadata = await requestMeetingMetadata({
      apiKey,
      transcriptText: transcript,
    });

    return template
      .replace(TITLE_PLACEHOLDER, metadata.title)
      .replace(DESCRIPTION_PLACEHOLDER, metadata.description);
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
