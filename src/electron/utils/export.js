const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const readPositiveInteger = (value, fallbackValue) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
};

const MP3_BITRATE_KBPS = readPositiveInteger(process.env.MEETLIFY_MP3_BITRATE_KBPS, 96);
const MP3_BITRATE = `${MP3_BITRATE_KBPS}k`;
const MP3_CHUNK_SIZE_MB = readPositiveInteger(process.env.MEETLIFY_MP3_CHUNK_SIZE_MB, 90);
const MP3_CHUNK_TARGET_BYTES = Math.max(1, MP3_CHUNK_SIZE_MB - 2) * 1024 * 1024;
const MP3_CHUNK_DURATION_SECONDS = Math.max(60, Math.floor((MP3_CHUNK_TARGET_BYTES * 8) / (MP3_BITRATE_KBPS * 1000)));

let cachedFfmpegPath = null;

const resolveFfmpegPath = () => {
  if (cachedFfmpegPath) {
    return cachedFfmpegPath;
  }

  const candidates = [
    process.env.FFMPEG_PATH,
    process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, "bin", "ffmpeg") : null,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }

  const whichResult = spawnSync("/usr/bin/which", ["ffmpeg"], {
    encoding: "utf8",
  });

  if (whichResult.status === 0) {
    const resolvedPath = whichResult.stdout.trim();
    if (resolvedPath && fs.existsSync(resolvedPath)) {
      cachedFfmpegPath = resolvedPath;
      return resolvedPath;
    }
  }

  throw new Error("FFmpeg is required for MP3 export. Install it with `brew install ffmpeg` and restart Meetlify.");
};

const runProcess = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}.`));
    });
  });

const buildFfmpegArgs = (inputPath) => [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  inputPath,
  "-vn",
  "-map_metadata",
  "-1",
  "-ac",
  "1",
  "-ar",
  "44100",
  "-codec:a",
  "libmp3lame",
  "-b:a",
  MP3_BITRATE,
];

const exportRecordingToMp3 = async ({ filePath, chunked = false }) => {
  const ffmpegPath = resolveFfmpegPath();
  const stats = await fsPromises.stat(filePath);

  if (!stats.isFile() || stats.size <= 42) {
    throw new Error("Recording file is empty or invalid.");
  }

  const parsed = path.parse(filePath);

  if (!chunked) {
    const outputPath = path.join(parsed.dir, `${parsed.name}.mp3`);

    await runProcess(ffmpegPath, [...buildFfmpegArgs(filePath), outputPath]);

    return {
      chunked: false,
      outputPath,
      outputDirectory: parsed.dir,
      fileCount: 1,
      files: [outputPath],
    };
  }

  const outputDirectory = path.join(parsed.dir, `${parsed.name}-mp3-chunks`);
  const outputPattern = path.join(outputDirectory, `${parsed.name}.part%03d.mp3`);

  await fsPromises.rm(outputDirectory, { recursive: true, force: true });
  await fsPromises.mkdir(outputDirectory, { recursive: true });

  await runProcess(ffmpegPath, [
    ...buildFfmpegArgs(filePath),
    "-f",
    "segment",
    "-segment_time",
    String(MP3_CHUNK_DURATION_SECONDS),
    "-reset_timestamps",
    "1",
    "-segment_start_number",
    "1",
    outputPattern,
  ]);

  const files = (await fsPromises.readdir(outputDirectory))
    .filter((entry) => entry.toLowerCase().endsWith(".mp3"))
    .sort()
    .map((entry) => path.join(outputDirectory, entry));

  if (!files.length) {
    throw new Error("MP3 export finished without producing any chunk files.");
  }

  return {
    chunked: true,
    outputDirectory,
    outputPath: files[0],
    fileCount: files.length,
    files,
  };
};

module.exports = {
  exportRecordingToMp3,
  resolveFfmpegPath,
};
