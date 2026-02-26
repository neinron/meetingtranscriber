const fs = require("node:fs/promises");
const path = require("node:path");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash";

const buildPrompt = () => [
  "You are a precise meeting transcription assistant.",
  "Produce a diarized transcript as markdown.",
  "Requirements:",
  "1. Use markdown only.",
  "2. Start with '# Meeting Transcript'.",
  "3. Then add '## Transcript'.",
  "4. Transcript lines must follow this format: [HH:MM:SS] Speaker N: utterance",
  "5. Infer distinct speakers and keep labels stable (Speaker 1, Speaker 2, etc.).",
  "6. Do not include any summary section.",
  "7. Do not include action items, conclusions, or recommendations.",
  "8. Include only the transcript content.",
  "9. If uncertain about a word, use [inaudible].",
].join("\n");

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
    const markdown = await requestTranscript({
      apiKey,
      model,
      fileUri: uploadedFile.uri,
      mimeType,
    });

    return markdown;
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
