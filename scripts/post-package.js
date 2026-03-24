const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const resolvePackagedAppPath = (outputPaths = []) => {
  for (const outputPath of outputPaths) {
    const candidates = [
      outputPath,
      path.join(outputPath, "Meetlify.app"),
    ];

    for (const candidate of candidates) {
      if (candidate.endsWith(".app") && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error("Packaged Meetlify.app not found after packaging.");
};

const copyPackagedAppToMainFolder = async (_forgeConfig, { outputPaths }) => {
  const packagedAppPath = resolvePackagedAppPath(outputPaths);
  const mainFolderPath = path.resolve(__dirname, "..", "..");
  const destinationPath = path.join(mainFolderPath, "Meetlify.app");

  await fsPromises.rm(destinationPath, { recursive: true, force: true });
  await fsPromises.cp(packagedAppPath, destinationPath, { recursive: true });
};

module.exports = {
  copyPackagedAppToMainFolder,
};
