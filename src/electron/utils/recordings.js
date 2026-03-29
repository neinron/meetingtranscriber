const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const util = require("node:util");
const { resolveFfmpegPath } = require("./export");

const execFileAsync = util.promisify(execFile);

const LIBRARY_DIR_NAME = ".meetlify";
const LIBRARY_FILE_NAME = "recordings-index.json";
const DERIVED_DIR_NAME = "derived";
const LIBRARY_VERSION = 2;
const MIN_VALID_MEDIA_BYTES = 43;
const NORMALIZED_AUDIO_SAMPLE_RATE = 16000;
const NORMALIZED_AUDIO_CHANNELS = 1;
const READY_STATUS = "ready";
const NEEDS_REVIEW_STATUS = "needs_review";
const ERROR_STATUS = "error";
const TRANSIENT_STATUSES = new Set(["recording", "stopping", "finalizing", "importing", "transcribing"]);
const VALID_STATUSES = new Set([READY_STATUS, NEEDS_REVIEW_STATUS, ERROR_STATUS, ...TRANSIENT_STATUSES]);
const UUID_BASENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEGACY_RECORDER_ARTIFACT_PATTERNS = [
  /^\..+\.mic\.\d+\.caf$/u,
  /^\..+\.system\.\d+\.caf$/u,
  /^\..+\.preview\.wav$/u,
  /^.+\.mixed\.caf$/u,
];
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".ac3",
  ".aif",
  ".aiff",
  ".amr",
  ".ape",
  ".au",
  ".caf",
  ".dts",
  ".flac",
  ".m4a",
  ".m4b",
  ".mka",
  ".mp2",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".ra",
  ".wav",
  ".weba",
  ".wma",
  ".wv",
]);
const VIDEO_EXTENSIONS = new Set([
  ".3g2",
  ".3gp",
  ".asf",
  ".avi",
  ".flv",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".ogv",
  ".qt",
  ".ts",
  ".webm",
  ".wmv",
]);
const SUPPORTED_MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const SUPPORTED_MEDIA_FILTER_EXTENSIONS = Array.from(SUPPORTED_MEDIA_EXTENSIONS)
  .map((extension) => extension.slice(1))
  .sort();
let libraryMutationQueue = Promise.resolve();

const buildRecordingId = () => crypto.randomUUID();
const getRecordingFingerprint = (stats) => {
  const timestamp = Math.round((stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || 0) / 1000);
  return `${stats.size}:${timestamp}`;
};

const getLibraryDir = (recordingsFolderPath) => path.join(recordingsFolderPath, LIBRARY_DIR_NAME);
const getLibraryPath = (recordingsFolderPath) => path.join(getLibraryDir(recordingsFolderPath), LIBRARY_FILE_NAME);
const getDerivedDir = (recordingsFolderPath) => path.join(getLibraryDir(recordingsFolderPath), DERIVED_DIR_NAME);
const getManagedTranscriptPath = (recordingId, transcriptsFolderPath) =>
  path.join(transcriptsFolderPath, `${recordingId}.transcript.md`);
const getManagedMediaPath = (recordingId, mediaExt, recordingsFolderPath) =>
  path.join(recordingsFolderPath, `${recordingId}${mediaExt}`);
const getNormalizedAudioPath = (recordingId, recordingsFolderPath) =>
  path.join(getDerivedDir(recordingsFolderPath), `${recordingId}.normalized.flac`);
const isUuidLikeBasename = (value) => UUID_BASENAME_PATTERN.test(String(value || "").trim());
const hasUsableMediaSize = (sizeBytes) => Number(sizeBytes) > MIN_VALID_MEDIA_BYTES;
const isLegacyRecorderArtifactName = (entryName) =>
  LEGACY_RECORDER_ARTIFACT_PATTERNS.some((pattern) => pattern.test(String(entryName || "")));
const normalizeQualityFlags = (qualityFlags) => Array.isArray(qualityFlags)
  ? Array.from(new Set(qualityFlags.map((flag) => String(flag || "").trim()).filter(Boolean)))
  : [];

const ensureDirectory = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
};

const isPathInsideDirectory = (targetPath, directoryPath) => {
  const relativePath = path.relative(directoryPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const fileExists = async (targetPath) => {
  if (!targetPath) {
    return false;
  }

  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const sanitizeDisplayName = (value, fallbackValue = "Meeting") => {
  const candidate = String(value || "")
    .replace(/\.[^/.]+$/u, "")
    .trim()
    .replace(/\s+/gu, " ");

  return candidate || fallbackValue;
};

const sanitizeExportBaseName = (value, fallbackValue = "Meeting") =>
  sanitizeDisplayName(value, fallbackValue).replace(/[/:*?"<>|]/gu, "-");

const resolveFfprobePath = () => {
  const ffmpegPath = resolveFfmpegPath();
  const siblingProbePath = path.join(path.dirname(ffmpegPath), "ffprobe");
  const candidates = [
    siblingProbePath,
    process.env.FFPROBE_PATH,
    process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, "bin", "ffprobe") : null,
    "/opt/homebrew/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "/usr/bin/ffprobe",
  ].filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return require("node:fs").existsSync(candidate);
    } catch {
      return false;
    }
  }) || siblingProbePath;
};

const probeMediaType = async (sourcePath) => {
  try {
    const { stdout } = await execFileAsync(resolveFfprobePath(), [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      sourcePath,
    ], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });

    const streamTypes = new Set(
      String(stdout)
        .split(/\r?\n/u)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    );

    if (streamTypes.has("video")) {
      return "video";
    }
    if (streamTypes.has("audio")) {
      return "audio";
    }
  } catch {
    // Fall through to afinfo for audio-only probing.
  }

  try {
    await execFileAsync("/usr/bin/afinfo", [sourcePath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return "audio";
  } catch {
    return null;
  }
};

const resolveImportMediaDescriptor = async (sourcePath) => {
  const mediaExt = path.extname(sourcePath).toLowerCase();
  const knownMediaType = getKnownMediaTypeForExtension(mediaExt);
  if (knownMediaType) {
    return {
      mediaExt,
      mediaType: knownMediaType,
    };
  }

  const probedMediaType = await probeMediaType(sourcePath);
  if (!probedMediaType) {
    return null;
  }

  return {
    mediaExt,
    mediaType: probedMediaType,
  };
};

const isSupportedMediaExtension = (extension) => SUPPORTED_MEDIA_EXTENSIONS.has(String(extension || "").toLowerCase());
const getKnownMediaTypeForExtension = (extension) => {
  const normalizedExtension = String(extension || "").toLowerCase();
  if (VIDEO_EXTENSIONS.has(normalizedExtension)) {
    return "video";
  }
  if (AUDIO_EXTENSIONS.has(normalizedExtension)) {
    return "audio";
  }
  return null;
};
const getMediaTypeForExtension = (extension) => getKnownMediaTypeForExtension(extension) || "audio";
const requiresNormalizedAudio = () => true;

const normalizeStatus = (
  status,
  {
    id,
    activeIds,
    fileExists: mediaFileExists,
    sizeBytes,
    transcriptPath = null,
    qualityFlags = [],
  }
) => {
  const hasValidMedia = mediaFileExists && hasUsableMediaSize(sizeBytes);
  const hasTranscript = Boolean(transcriptPath);
  const normalizedQualityFlags = normalizeQualityFlags(qualityFlags);
  const fallbackReadyStatus = normalizedQualityFlags.length ? NEEDS_REVIEW_STATUS : READY_STATUS;
  if (VALID_STATUSES.has(status)) {
    if (TRANSIENT_STATUSES.has(status) && !(activeIds instanceof Set && activeIds.has(id))) {
      if (status === "transcribing") {
        return hasTranscript ? fallbackReadyStatus : ERROR_STATUS;
      }
      if (status === "recording" || status === "stopping" || status === "finalizing" || status === "importing") {
        return hasValidMedia ? fallbackReadyStatus : ERROR_STATUS;
      }
    }
    if (status === READY_STATUS || status === NEEDS_REVIEW_STATUS) {
      return hasValidMedia ? (normalizedQualityFlags.length ? NEEDS_REVIEW_STATUS : status) : ERROR_STATUS;
    }
    return status;
  }

  return hasValidMedia ? fallbackReadyStatus : ERROR_STATUS;
};

const readLibraryManifest = async (recordingsFolderPath) => {
  try {
    const raw = await fs.readFile(getLibraryPath(recordingsFolderPath), "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: Number(parsed?.version) || 1,
      recordings: Array.isArray(parsed?.recordings) ? parsed.recordings : [],
    };
  } catch {
    return {
      version: LIBRARY_VERSION,
      recordings: [],
    };
  }
};

const writeLibraryManifest = async (recordingsFolderPath, recordings) => {
  await ensureDirectory(getLibraryDir(recordingsFolderPath));
  await fs.writeFile(
    getLibraryPath(recordingsFolderPath),
    JSON.stringify({
      version: LIBRARY_VERSION,
      updatedAt: new Date().toISOString(),
      recordings,
    }, null, 2),
    "utf8",
  );
};

const renameOrCopy = async (sourcePath, targetPath) => {
  if (!sourcePath || !targetPath || sourcePath === targetPath) {
    return;
  }

  await ensureDirectory(path.dirname(targetPath));

  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (await fileExists(targetPath)) {
        return;
      }
      throw error;
    }

    if (error?.code !== "EXDEV") {
      throw error;
    }

    await fs.cp(sourcePath, targetPath, { force: true });
    await fs.rm(sourcePath, { force: true });
  }
};

const withLibraryMutation = async (operation) => {
  const previousOperation = libraryMutationQueue.catch(() => {});
  let releaseQueue = null;
  libraryMutationQueue = new Promise((resolve) => {
    releaseQueue = resolve;
  });

  await previousOperation;
  try {
    return await operation();
  } finally {
    releaseQueue?.();
  }
};

const cleanupLegacyRecorderArtifacts = async (recordingsFolderPath, scanEntries) => {
  const cleanedEntries = [];

  for (const entry of scanEntries) {
    if (!entry?.isFile?.()) {
      cleanedEntries.push(entry);
      continue;
    }

    if (!isLegacyRecorderArtifactName(entry.name)) {
      cleanedEntries.push(entry);
      continue;
    }

    await fs.rm(path.join(recordingsFolderPath, entry.name), { force: true }).catch(() => {});
  }

  return cleanedEntries;
};

const getLegacyTranscriptCandidates = ({
  entry,
  currentMediaPath,
  currentDisplayName,
  recordingId,
  transcriptsFolderPath,
}) => {
  const candidates = new Set();
  const entryTranscriptPath = entry?.transcriptPath || null;
  if (entryTranscriptPath) {
    candidates.add(entryTranscriptPath);
  }

  const legacyPath = entry?.audioPath || entry?.mediaPath || currentMediaPath;
  if (legacyPath) {
    candidates.add(path.join(transcriptsFolderPath, `${path.parse(legacyPath).name}.transcript.md`));
  }

  if (currentDisplayName) {
    candidates.add(path.join(transcriptsFolderPath, `${currentDisplayName}.transcript.md`));
  }

  candidates.add(getManagedTranscriptPath(recordingId, transcriptsFolderPath));
  return Array.from(candidates).filter(Boolean);
};

const resolveManagedTranscript = async ({
  entry,
  currentMediaPath,
  currentDisplayName,
  recordingId,
  transcriptsFolderPath,
}) => {
  const managedTranscriptPath = getManagedTranscriptPath(recordingId, transcriptsFolderPath);

  for (const candidatePath of getLegacyTranscriptCandidates({
    entry,
    currentMediaPath,
    currentDisplayName,
    recordingId,
    transcriptsFolderPath,
  })) {
    if (!await fileExists(candidatePath)) {
      continue;
    }

    if (candidatePath !== managedTranscriptPath) {
      await renameOrCopy(candidatePath, managedTranscriptPath);
    }

    return managedTranscriptPath;
  }

  return null;
};

const normalizeManifestEntry = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const mediaPath = entry.mediaPath || entry.audioPath || null;
  const mediaExt = path.extname(mediaPath || entry.mediaExt || ".flac").toLowerCase() || ".flac";
  const displayName = sanitizeDisplayName(
    entry.displayName || entry.name || path.parse(mediaPath || "Meeting").name,
    "Meeting"
  );
  const recordingId = entry.id || buildRecordingId();
  const mediaType = entry.mediaType || getMediaTypeForExtension(mediaExt);
  const origin = entry.origin || "recorded";

  return {
    id: recordingId,
    displayName,
    mediaPath,
    mediaExt,
    mediaType,
    origin,
    transcriptPath: entry.transcriptPath || null,
    normalizedAudioPath: entry.normalizedAudioPath || null,
    status: VALID_STATUSES.has(entry.status) ? entry.status : READY_STATUS,
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
    sizeBytes: Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : null,
    durationSeconds: Number.isFinite(entry.durationSeconds) ? entry.durationSeconds : null,
    lastError: entry.lastError || null,
    statusDetail: entry.statusDetail || null,
    qualityFlags: normalizeQualityFlags(entry.qualityFlags),
    lastTranscriptionModel: entry.lastTranscriptionModel || null,
    lastTranscriptionCompletedAt: entry.lastTranscriptionCompletedAt || null,
    fingerprint: entry.fingerprint || null,
  };
};

const findBestLegacyMatch = ({ mediaPath, fingerprint, normalizedEntries, claimedIds }) => {
  const byPath = normalizedEntries.find((entry) => {
    const candidatePath = entry?.mediaPath || entry?.audioPath;
    return candidatePath === mediaPath;
  });
  if (byPath && !claimedIds.has(byPath.id)) {
    return byPath;
  }

  const byFingerprint = normalizedEntries.find((entry) =>
    entry?.fingerprint === fingerprint && !claimedIds.has(entry.id));
  if (byFingerprint) {
    return byFingerprint;
  }

  return null;
};

const synchronizeLibraryStateUnsafe = async (
  recordingsFolderPath,
  transcriptsFolderPath = recordingsFolderPath,
  { activeIds = [] } = {}
) => {
  await ensureDirectory(recordingsFolderPath);
  await ensureDirectory(transcriptsFolderPath);
  await ensureDirectory(getDerivedDir(recordingsFolderPath));

  const activeIdSet = activeIds instanceof Set ? activeIds : new Set(activeIds);
  const manifest = await readLibraryManifest(recordingsFolderPath);
  const normalizedEntries = manifest.recordings
    .map(normalizeManifestEntry)
    .filter(Boolean);
  const claimedIds = new Set();
  const prunedIds = new Set();
  const nextEntries = [];
  const scanEntries = await cleanupLegacyRecorderArtifacts(
    recordingsFolderPath,
    await fs.readdir(recordingsFolderPath, { withFileTypes: true })
  );
  const mediaFiles = scanEntries.filter((entry) => {
    if (!entry.isFile()) {
      return false;
    }

    if (entry.name.startsWith(".")) {
      return false;
    }

    return isSupportedMediaExtension(path.extname(entry.name));
  });

  for (const mediaFile of mediaFiles) {
    const originalMediaPath = path.join(recordingsFolderPath, mediaFile.name);
    const mediaStats = await fs.stat(originalMediaPath);
    const mediaExt = path.extname(mediaFile.name).toLowerCase();
    const fingerprint = getRecordingFingerprint(mediaStats);
    const legacyEntry = findBestLegacyMatch({
      mediaPath: originalMediaPath,
      fingerprint,
      normalizedEntries,
      claimedIds,
    });
    const recordingBasename = path.parse(mediaFile.name).name;

    if (isUuidLikeBasename(recordingBasename) && !hasUsableMediaSize(mediaStats.size)) {
      await fs.rm(originalMediaPath, { force: true }).catch(() => {});
      if (legacyEntry?.id) {
        prunedIds.add(legacyEntry.id);
      } else {
        prunedIds.add(recordingBasename);
      }
      continue;
    }

    const legacyNormalizedAudioPath = legacyEntry?.normalizedAudioPath && await fileExists(legacyEntry.normalizedAudioPath)
      ? legacyEntry.normalizedAudioPath
      : null;
    const shouldPruneOrphanedAutoIngestedCaf = mediaExt === ".caf"
      && legacyEntry?.origin === "auto_ingested"
      && isUuidLikeBasename(recordingBasename)
      && isUuidLikeBasename(legacyEntry.displayName)
      && !legacyEntry.transcriptPath
      && !legacyNormalizedAudioPath;
    if (shouldPruneOrphanedAutoIngestedCaf) {
      await fs.rm(originalMediaPath, { force: true }).catch(() => {});
      prunedIds.add(legacyEntry.id);
      continue;
    }

    const recordingId = legacyEntry?.id || buildRecordingId();
    const currentDisplayName = sanitizeDisplayName(
      legacyEntry?.displayName || path.parse(mediaFile.name).name,
      "Meeting"
    );
    const managedMediaPath = getManagedMediaPath(recordingId, mediaExt, recordingsFolderPath);

    if (originalMediaPath !== managedMediaPath) {
      await renameOrCopy(originalMediaPath, managedMediaPath);
    }

    const managedTranscriptPath = await resolveManagedTranscript({
      entry: legacyEntry,
      currentMediaPath: originalMediaPath,
      currentDisplayName,
      recordingId,
      transcriptsFolderPath,
    });
    const normalizedAudioPath = await fileExists(getNormalizedAudioPath(recordingId, recordingsFolderPath))
      ? getNormalizedAudioPath(recordingId, recordingsFolderPath)
      : legacyNormalizedAudioPath;

    claimedIds.add(recordingId);
    nextEntries.push({
      id: recordingId,
      displayName: currentDisplayName,
      mediaPath: managedMediaPath,
      mediaExt,
      mediaType: getMediaTypeForExtension(mediaExt),
      origin: legacyEntry?.origin || (legacyEntry ? "recorded" : "auto_ingested"),
      transcriptPath: managedTranscriptPath,
      normalizedAudioPath,
      status: normalizeStatus(legacyEntry?.status || READY_STATUS, {
        id: recordingId,
        activeIds: activeIdSet,
        fileExists: true,
        sizeBytes: mediaStats.size,
        transcriptPath: managedTranscriptPath,
        qualityFlags: legacyEntry?.qualityFlags || [],
      }),
      createdAt: legacyEntry?.createdAt || new Date(mediaStats.birthtimeMs || mediaStats.ctimeMs || mediaStats.mtimeMs).toISOString(),
      updatedAt: new Date().toISOString(),
      sizeBytes: mediaStats.size,
      durationSeconds: Number.isFinite(legacyEntry?.durationSeconds) ? legacyEntry.durationSeconds : null,
      lastError: legacyEntry?.lastError || null,
      statusDetail: legacyEntry?.statusDetail || null,
      qualityFlags: normalizeQualityFlags(legacyEntry?.qualityFlags),
      lastTranscriptionModel: legacyEntry?.lastTranscriptionModel || null,
      lastTranscriptionCompletedAt: legacyEntry?.lastTranscriptionCompletedAt || null,
      fingerprint,
    });
  }

  for (const legacyEntry of normalizedEntries) {
    if (claimedIds.has(legacyEntry.id) || prunedIds.has(legacyEntry.id)) {
      continue;
    }

    const mediaPath = legacyEntry.mediaPath || getManagedMediaPath(legacyEntry.id, legacyEntry.mediaExt || ".flac", recordingsFolderPath);
    const mediaIsPresent = await fileExists(mediaPath);
    let sizeBytes = Number.isFinite(legacyEntry.sizeBytes) ? legacyEntry.sizeBytes : null;
    let fingerprint = legacyEntry.fingerprint || null;

    if (mediaIsPresent) {
      const stats = await fs.stat(mediaPath);
      sizeBytes = stats.size;
      fingerprint = getRecordingFingerprint(stats);
    }

    const transcriptPath = await resolveManagedTranscript({
      entry: legacyEntry,
      currentMediaPath: mediaPath,
      currentDisplayName: legacyEntry.displayName,
      recordingId: legacyEntry.id,
      transcriptsFolderPath,
    });
    const normalizedAudioPath = legacyEntry.normalizedAudioPath && await fileExists(legacyEntry.normalizedAudioPath)
      ? legacyEntry.normalizedAudioPath
      : null;
    const shouldPruneOrphanedAutoIngestedCaf = mediaIsPresent
      && legacyEntry.origin === "auto_ingested"
      && legacyEntry.mediaExt === ".caf"
      && isUuidLikeBasename(path.parse(mediaPath || "").name)
      && isUuidLikeBasename(legacyEntry.displayName)
      && !transcriptPath
      && !normalizedAudioPath;
    if (shouldPruneOrphanedAutoIngestedCaf) {
      await fs.rm(mediaPath, { force: true }).catch(() => {});
      continue;
    }
    const shouldPruneMissingManagedEntry = !mediaIsPresent
      && isUuidLikeBasename(path.parse(mediaPath || "").name)
      && !transcriptPath
      && !normalizedAudioPath
      && !activeIdSet.has(legacyEntry.id)
      && (!legacyEntry.lastError || legacyEntry.lastError === "Managed media file is missing.");

    if (shouldPruneMissingManagedEntry) {
      continue;
    }

    nextEntries.push({
      ...legacyEntry,
      mediaPath,
      mediaExt: (legacyEntry.mediaExt || path.extname(mediaPath || ".flac")).toLowerCase() || ".flac",
      mediaType: legacyEntry.mediaType || getMediaTypeForExtension(legacyEntry.mediaExt || path.extname(mediaPath || ".flac")),
      transcriptPath,
      normalizedAudioPath,
      status: normalizeStatus(legacyEntry.status, {
        id: legacyEntry.id,
        activeIds: activeIdSet,
        fileExists: mediaIsPresent,
        sizeBytes,
        transcriptPath,
        qualityFlags: legacyEntry.qualityFlags,
      }),
      sizeBytes: mediaIsPresent ? sizeBytes : null,
      fingerprint: mediaIsPresent ? fingerprint : null,
      updatedAt: new Date().toISOString(),
      lastError: mediaIsPresent
        ? legacyEntry.lastError
        : (legacyEntry.lastError || "Managed media file is missing."),
      statusDetail: legacyEntry.statusDetail || null,
      qualityFlags: normalizeQualityFlags(legacyEntry.qualityFlags),
      lastTranscriptionModel: legacyEntry.lastTranscriptionModel || null,
      lastTranscriptionCompletedAt: legacyEntry.lastTranscriptionCompletedAt || null,
    });
  }

  nextEntries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  await writeLibraryManifest(recordingsFolderPath, nextEntries);
  return nextEntries;
};

const synchronizeLibraryState = async (
  recordingsFolderPath,
  transcriptsFolderPath = recordingsFolderPath,
  options = {}
) => withLibraryMutation(() =>
  synchronizeLibraryStateUnsafe(recordingsFolderPath, transcriptsFolderPath, options)
);

const toRendererRecording = (entry) => ({
  id: entry.id,
  name: entry.displayName,
  displayName: entry.displayName,
  path: entry.mediaPath,
  mediaPath: entry.mediaPath,
  mediaExt: entry.mediaExt,
  mediaType: entry.mediaType,
  origin: entry.origin,
  sizeBytes: entry.sizeBytes,
  createdAt: entry.createdAt,
  modifiedAt: entry.updatedAt,
  transcriptPath: entry.transcriptPath,
  normalizedAudioPath: entry.normalizedAudioPath,
  status: entry.status,
  lastError: entry.lastError,
  statusDetail: entry.statusDetail,
  qualityFlags: normalizeQualityFlags(entry.qualityFlags),
  lastTranscriptionModel: entry.lastTranscriptionModel || null,
  lastTranscriptionCompletedAt: entry.lastTranscriptionCompletedAt || null,
  isBusy: TRANSIENT_STATUSES.has(entry.status),
  hasUsableMedia: hasUsableMediaSize(entry.sizeBytes),
  canTranscribe: hasUsableMediaSize(entry.sizeBytes) && !["recording", "stopping", "finalizing", "importing"].includes(entry.status),
  canExport: hasUsableMediaSize(entry.sizeBytes) && !["recording", "stopping", "finalizing", "importing", "transcribing"].includes(entry.status),
  canOpen: entry.status === READY_STATUS
    || entry.status === NEEDS_REVIEW_STATUS
    || entry.status === ERROR_STATUS
    || entry.status === "transcribing",
  isSelectable: entry.status === READY_STATUS
    ? hasUsableMediaSize(entry.sizeBytes)
    : entry.status === NEEDS_REVIEW_STATUS
    ? hasUsableMediaSize(entry.sizeBytes)
    : entry.status === ERROR_STATUS,
});

const listRecordings = async (recordingsFolderPath, transcriptsFolderPath = recordingsFolderPath, options = {}) => {
  const entries = await synchronizeLibraryState(recordingsFolderPath, transcriptsFolderPath, options);
  return entries.map(toRendererRecording);
};

const getRecordingById = async (recordingsFolderPath, transcriptsFolderPath, recordingId, options = {}) => {
  const entries = await synchronizeLibraryState(recordingsFolderPath, transcriptsFolderPath, options);
  return entries.find((entry) => entry.id === recordingId) || null;
};

const updateRecordingEntry = async (recordingsFolderPath, recordingId, update, transcriptsFolderPath = recordingsFolderPath) => {
  return withLibraryMutation(async () => {
    const manifest = await readLibraryManifest(recordingsFolderPath);
    const normalizedEntries = manifest.recordings.map(normalizeManifestEntry).filter(Boolean);
    let updatedEntry = null;
    const nextEntries = normalizedEntries.map((entry) => {
      if (entry.id !== recordingId) {
        return entry;
      }

      const patch = typeof update === "function" ? update(entry) : update;
      updatedEntry = {
        ...entry,
        ...patch,
        id: entry.id,
        updatedAt: new Date().toISOString(),
      };
      updatedEntry.qualityFlags = normalizeQualityFlags(updatedEntry.qualityFlags);
      return updatedEntry;
    });

    await writeLibraryManifest(recordingsFolderPath, nextEntries);
    return updatedEntry;
  });
};

const removeRecordingEntry = async (recordingsFolderPath, recordingId) => {
  await withLibraryMutation(async () => {
    const manifest = await readLibraryManifest(recordingsFolderPath);
    const nextEntries = manifest.recordings
      .map(normalizeManifestEntry)
      .filter(Boolean)
      .filter((entry) => entry.id !== recordingId);

    await writeLibraryManifest(recordingsFolderPath, nextEntries);
  });
};

const deleteRecording = async ({
  recordingsFolderPath,
  transcriptsFolderPath = recordingsFolderPath,
  recordingId,
}) => {
  const manifest = await readLibraryManifest(recordingsFolderPath);
  const normalizedEntries = manifest.recordings.map(normalizeManifestEntry).filter(Boolean);
  const entry = normalizedEntries.find((item) => item.id === recordingId) || null;

  if (!entry) {
    return null;
  }

  const cleanupTargets = new Set([
    entry.mediaPath,
    entry.transcriptPath,
    entry.normalizedAudioPath,
    getManagedTranscriptPath(recordingId, transcriptsFolderPath),
  ].filter(Boolean));

  for (const targetPath of cleanupTargets) {
    await fs.rm(targetPath, { force: true }).catch(() => {});
  }

  const derivedDir = getDerivedDir(recordingsFolderPath);
  const derivedEntries = await fs.readdir(derivedDir).catch(() => []);
  await Promise.all(
    derivedEntries
      .filter((entryName) => entryName === recordingId || entryName.startsWith(`${recordingId}.`))
      .map((entryName) => fs.rm(path.join(derivedDir, entryName), { force: true }).catch(() => {}))
  );

  await removeRecordingEntry(recordingsFolderPath, recordingId);
  return entry;
};

const createRecordingEntry = async ({
  recordingsFolderPath,
  transcriptsFolderPath = recordingsFolderPath,
  displayName,
  mediaExt = ".flac",
  mediaType = "audio",
  origin = "recorded",
  status = "recording",
}) => {
  const recordingId = buildRecordingId();
  const entry = {
    id: recordingId,
    displayName: sanitizeDisplayName(displayName, "Meeting"),
    mediaPath: getManagedMediaPath(recordingId, mediaExt.toLowerCase(), recordingsFolderPath),
    mediaExt: mediaExt.toLowerCase(),
    mediaType,
    origin,
    transcriptPath: await fileExists(getManagedTranscriptPath(recordingId, transcriptsFolderPath))
      ? getManagedTranscriptPath(recordingId, transcriptsFolderPath)
      : null,
    normalizedAudioPath: null,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sizeBytes: null,
    durationSeconds: null,
    lastError: null,
    statusDetail: null,
    qualityFlags: [],
    lastTranscriptionModel: null,
    lastTranscriptionCompletedAt: null,
    fingerprint: null,
  };

  await withLibraryMutation(async () => {
    const manifest = await readLibraryManifest(recordingsFolderPath);
    const nextEntries = manifest.recordings
      .map(normalizeManifestEntry)
      .filter(Boolean)
      .concat(entry);

    await writeLibraryManifest(recordingsFolderPath, nextEntries);
  });
  return entry;
};

const renameRecording = async ({
  recordingsFolderPath,
  transcriptsFolderPath = recordingsFolderPath,
  recordingId,
  displayName,
}) => {
  return updateRecordingEntry(
    recordingsFolderPath,
    recordingId,
    { displayName: sanitizeDisplayName(displayName, "Meeting") },
    transcriptsFolderPath,
  );
};

const updateRecordingTranscriptPath = async ({
  recordingsFolderPath,
  transcriptsFolderPath = recordingsFolderPath,
  recordingId,
  transcriptPath,
}) => {
  return updateRecordingEntry(
    recordingsFolderPath,
    recordingId,
    {
      transcriptPath: transcriptPath || getManagedTranscriptPath(recordingId, transcriptsFolderPath),
    },
    transcriptsFolderPath,
  );
};

const tryNormalizeWithAfconvert = async (sourcePath, outputPath) => {
  await execFileAsync("/usr/bin/afconvert", [
    "-f",
    "flac",
    "-d",
    "flac",
    sourcePath,
    outputPath,
  ], {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
};

const normalizeWithFfmpeg = async (sourcePath, outputPath, mediaType) => {
  const ffmpegPath = resolveFfmpegPath();
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourcePath,
  ];

  if (mediaType === "video") {
    args.push("-vn");
  }

  args.push(
    "-ac",
    String(NORMALIZED_AUDIO_CHANNELS),
    "-ar",
    String(NORMALIZED_AUDIO_SAMPLE_RATE),
    "-c:a",
    "flac",
    outputPath,
  );

  await execFileAsync(ffmpegPath, args, {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
};

const ensureNormalizedAudio = async ({
  recordingsFolderPath,
  transcriptsFolderPath = recordingsFolderPath,
  recordingId,
  activeIds = [],
}) => {
  const entry = await getRecordingById(recordingsFolderPath, transcriptsFolderPath, recordingId, { activeIds });
  if (!entry) {
    throw new Error("Recording not found.");
  }

  const targetPath = getNormalizedAudioPath(recordingId, recordingsFolderPath);
  const existingTarget = await fileExists(targetPath);
  const sourceStats = await fs.stat(entry.mediaPath);
  const targetStats = existingTarget ? await fs.stat(targetPath) : null;
  const isFresh = targetStats && targetStats.mtimeMs >= sourceStats.mtimeMs && targetStats.size > 42;

  if (!isFresh) {
    await ensureDirectory(getDerivedDir(recordingsFolderPath));
    await fs.rm(targetPath, { force: true });

    try {
      await normalizeWithFfmpeg(entry.mediaPath, targetPath, entry.mediaType);
    } catch (error) {
      await updateRecordingEntry(recordingsFolderPath, recordingId, {
        status: ERROR_STATUS,
        lastError: `Audio normalization failed: ${error.message}`,
      }, transcriptsFolderPath);
      throw error;
    }
  }

  await updateRecordingEntry(recordingsFolderPath, recordingId, {
    normalizedAudioPath: targetPath,
    lastError: null,
    status: entry.status === "importing" ? READY_STATUS : entry.status,
  }, transcriptsFolderPath);

  return targetPath;
};

const importMediaFiles = async ({
  sourcePaths,
  recordingsFolderPath,
  transcriptsFolderPath = recordingsFolderPath,
}) => {
  const importedEntries = [];
  const rejectedEntries = [];
  const normalizedEntries = (await readLibraryManifest(recordingsFolderPath)).recordings
    .map(normalizeManifestEntry)
    .filter(Boolean);
  const managedSourcePaths = new Set(
    normalizedEntries
      .map((entry) => entry.mediaPath)
      .filter(Boolean)
      .map((entryPath) => path.resolve(entryPath))
  );
  const libraryRootPath = path.resolve(recordingsFolderPath);
  const libraryMetadataPath = path.resolve(getLibraryDir(recordingsFolderPath));

  for (const sourcePath of sourcePaths) {
    const mediaDescriptor = await resolveImportMediaDescriptor(sourcePath);
    if (!mediaDescriptor) {
      rejectedEntries.push({
        sourcePath,
        reason: "Unsupported media format.",
      });
      continue;
    }
    const { mediaExt, mediaType } = mediaDescriptor;
    const resolvedSourcePath = path.resolve(sourcePath);

    const displayName = sanitizeDisplayName(path.parse(sourcePath).name, "Meeting");
    const entry = await createRecordingEntry({
      recordingsFolderPath,
      transcriptsFolderPath,
      displayName,
      mediaExt,
      mediaType,
      origin: "imported",
      status: "importing",
    });

    try {
      const shouldMoveSourceIntoLibrary = isPathInsideDirectory(resolvedSourcePath, libraryRootPath)
        && !isPathInsideDirectory(resolvedSourcePath, libraryMetadataPath)
        && !managedSourcePaths.has(resolvedSourcePath);

      if (shouldMoveSourceIntoLibrary) {
        await renameOrCopy(sourcePath, entry.mediaPath);
      } else {
        await fs.copyFile(sourcePath, entry.mediaPath);
      }

      const mediaStats = await fs.stat(entry.mediaPath);
      await updateRecordingEntry(recordingsFolderPath, entry.id, {
        sizeBytes: mediaStats.size,
        fingerprint: getRecordingFingerprint(mediaStats),
        status: READY_STATUS,
        lastError: null,
      }, transcriptsFolderPath);
      managedSourcePaths.add(path.resolve(entry.mediaPath));

      if (requiresNormalizedAudio(entry)) {
        await ensureNormalizedAudio({
          recordingsFolderPath,
          transcriptsFolderPath,
          recordingId: entry.id,
        });
      }

      importedEntries.push(await getRecordingById(recordingsFolderPath, transcriptsFolderPath, entry.id));
    } catch (error) {
      await updateRecordingEntry(recordingsFolderPath, entry.id, {
        status: ERROR_STATUS,
        lastError: `Import failed: ${error.message}`,
      }, transcriptsFolderPath);
      importedEntries.push(await getRecordingById(recordingsFolderPath, transcriptsFolderPath, entry.id));
    }
  }

  return {
    imported: importedEntries.filter(Boolean).map(toRendererRecording),
    rejected: rejectedEntries,
  };
};

module.exports = {
  ERROR_STATUS,
  NEEDS_REVIEW_STATUS,
  READY_STATUS,
  SUPPORTED_MEDIA_EXTENSIONS,
  SUPPORTED_MEDIA_FILTER_EXTENSIONS,
  TRANSIENT_STATUSES,
  buildRecordingId,
  createRecordingEntry,
  ensureNormalizedAudio,
  getManagedMediaPath,
  getManagedTranscriptPath,
  getRecordingById,
  getRecordingFingerprint,
  getNormalizedAudioPath,
  importMediaFiles,
  isSupportedMediaExtension,
  listRecordings,
  normalizeStatus,
  deleteRecording,
  removeRecordingEntry,
  renameRecording,
  sanitizeDisplayName,
  sanitizeExportBaseName,
  synchronizeLibraryState,
  updateRecordingEntry,
  updateRecordingTranscriptPath,
};
