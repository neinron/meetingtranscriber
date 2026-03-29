const fs = require("node:fs/promises");
const path = require("node:path");

const getTranscriptPathForRecording = (recordingId, transcriptsFolderPath) => {
  if (!recordingId) {
    throw new Error("Missing recording ID for transcript path resolution.");
  }

  if (!transcriptsFolderPath) {
    throw new Error("Missing transcripts folder path.");
  }

  return path.join(transcriptsFolderPath, `${recordingId}.transcript.md`);
};

const saveMarkdown = async (markdownPath, content) => {
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  const tempPath = `${markdownPath}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, markdownPath);
};

const readMarkdown = async (markdownPath) => fs.readFile(markdownPath, "utf8");

module.exports = {
  getTranscriptPathForRecording,
  saveMarkdown,
  readMarkdown,
};
