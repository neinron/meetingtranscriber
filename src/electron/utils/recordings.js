const fs = require("node:fs/promises");
const path = require("node:path");

const listRecordings = async (folderPath, transcriptsFolderPath = folderPath) => {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });

  const recordings = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".flac"))
      .map(async (entry) => {
        const absolutePath = path.join(folderPath, entry.name);
        const stats = await fs.stat(absolutePath);
        const transcriptName = `${path.parse(entry.name).name}.transcript.md`;
        const transcriptPath = path.join(transcriptsFolderPath, transcriptName);

        return {
          name: entry.name,
          path: absolutePath,
          sizeBytes: stats.size,
          createdAt: new Date(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs).toISOString(),
          modifiedAt: stats.mtime.toISOString(),
          transcriptPath,
        };
      })
  );

  return recordings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};

module.exports = {
  listRecordings,
};
