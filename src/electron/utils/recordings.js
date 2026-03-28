const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const LIBRARY_DIR_NAME = ".meetlify";
const LIBRARY_FILE_NAME = "recordings-index.json";

const buildRecordingId = () => crypto.randomUUID();
const getRecordingFingerprint = (stats) => {
  const timestamp = Math.round((stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || 0) / 1000);
  return `${stats.size}:${timestamp}`;
};

const getLibraryDir = (recordingsFolderPath) => path.join(recordingsFolderPath, LIBRARY_DIR_NAME);
const getLibraryPath = (recordingsFolderPath) => path.join(getLibraryDir(recordingsFolderPath), LIBRARY_FILE_NAME);

const readLibraryIndex = async (recordingsFolderPath) => {
  try {
    const raw = await fs.readFile(getLibraryPath(recordingsFolderPath), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.recordings) ? parsed.recordings : [];
  } catch {
    return [];
  }
};

const writeLibraryIndex = async (recordingsFolderPath, recordings) => {
  const libraryDir = getLibraryDir(recordingsFolderPath);
  await fs.mkdir(libraryDir, { recursive: true });
  await fs.writeFile(
    getLibraryPath(recordingsFolderPath),
    JSON.stringify({ recordings }, null, 2),
    "utf8",
  );
};

const getLegacyTranscriptPath = (audioPath, transcriptsFolderPath) =>
  path.join(transcriptsFolderPath, `${path.parse(audioPath).name}.transcript.md`);

const getManagedTranscriptPath = (recordingId, transcriptsFolderPath) =>
  path.join(transcriptsFolderPath, `${recordingId}.transcript.md`);

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const findIndexEntryForAudioPath = (indexEntries, audioPath) =>
  indexEntries.find((entry) => entry?.audioPath === audioPath) || null;

const findIndexEntryForFingerprint = (indexEntries, fingerprint) =>
  indexEntries.find((entry) => entry?.fingerprint === fingerprint) || null;

const ensureIndexEntry = async ({
  indexEntries,
  recordingsFolderPath,
  transcriptsFolderPath,
  audioPath,
  stats,
}) => {
  const fingerprint = getRecordingFingerprint(stats);
  const existingEntry = findIndexEntryForAudioPath(indexEntries, audioPath);
  const fallbackDisplayName = path.basename(audioPath);

  if (existingEntry) {
    const recordingId = existingEntry.id || buildRecordingId();
    return {
      ...existingEntry,
      id: recordingId,
      audioPath,
      fingerprint,
      displayName: existingEntry.displayName || fallbackDisplayName,
      transcriptPath: existingEntry.transcriptPath || getManagedTranscriptPath(recordingId, transcriptsFolderPath),
      createdAt: existingEntry.createdAt || new Date(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const fingerprintMatch = findIndexEntryForFingerprint(indexEntries, fingerprint);
  if (fingerprintMatch) {
    const recordingId = fingerprintMatch.id || buildRecordingId();
    return {
      ...fingerprintMatch,
      id: recordingId,
      audioPath,
      fingerprint,
      displayName: fingerprintMatch.displayName || fallbackDisplayName,
      transcriptPath: fingerprintMatch.transcriptPath || getManagedTranscriptPath(recordingId, transcriptsFolderPath),
      createdAt: fingerprintMatch.createdAt || new Date(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const recordingId = buildRecordingId();
  const legacyTranscriptPath = getLegacyTranscriptPath(audioPath, transcriptsFolderPath);
  const transcriptPath = await fileExists(legacyTranscriptPath)
    ? legacyTranscriptPath
    : getManagedTranscriptPath(recordingId, transcriptsFolderPath);

  return {
    id: recordingId,
    audioPath,
    fingerprint,
    displayName: fallbackDisplayName,
    transcriptPath,
    createdAt: new Date(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs).toISOString(),
    updatedAt: new Date().toISOString(),
  };
};

const listRecordings = async (recordingsFolderPath, transcriptsFolderPath = recordingsFolderPath) => {
  const entries = await fs.readdir(recordingsFolderPath, { withFileTypes: true });
  const audioEntries = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".flac"));
  const existingIndex = await readLibraryIndex(recordingsFolderPath);
  const nextIndex = [];

  const recordings = await Promise.all(audioEntries.map(async (entry) => {
    const absolutePath = path.join(recordingsFolderPath, entry.name);
    const stats = await fs.stat(absolutePath);
    const indexEntry = await ensureIndexEntry({
      indexEntries: existingIndex,
      recordingsFolderPath,
      transcriptsFolderPath,
      audioPath: absolutePath,
      stats,
    });

    nextIndex.push(indexEntry);

    return {
      id: indexEntry.id,
      name: indexEntry.displayName,
      path: absolutePath,
      sizeBytes: stats.size,
      createdAt: new Date(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs).toISOString(),
      modifiedAt: stats.mtime.toISOString(),
      transcriptPath: indexEntry.transcriptPath,
    };
  }));

  await writeLibraryIndex(recordingsFolderPath, nextIndex);

  return recordings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};

module.exports = {
  listRecordings,
};
