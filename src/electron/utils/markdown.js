const fs = require("node:fs/promises");
const path = require("node:path");

const getTranscriptPathForRecording = (recordingPath, transcriptsFolderPath = null) => {
  const parsed = path.parse(recordingPath);
  const baseDir = transcriptsFolderPath || parsed.dir;
  return path.join(baseDir, `${parsed.name}.transcript.md`);
};

const saveMarkdown = async (markdownPath, content) => {
  await fs.writeFile(markdownPath, content, "utf8");
};

const readMarkdown = async (markdownPath) => fs.readFile(markdownPath, "utf8");

module.exports = {
  getTranscriptPathForRecording,
  saveMarkdown,
  readMarkdown,
};
