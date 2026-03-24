const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

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

const signBundle = async (bundlePath, identifier) => {
  await execFileAsync("codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--identifier",
    identifier,
    bundlePath,
  ]);
};

const signInstalledApp = async (applicationsPath) => {
  const recorderSourcePath = path.join(applicationsPath, "Contents", "Resources", "Recorder");
  const recorderInstalledPath = path.join(applicationsPath, "Contents", "MacOS", "Recorder");

  if (fs.existsSync(recorderSourcePath)) {
    await fsPromises.cp(recorderSourcePath, recorderInstalledPath, { force: true });
    await fsPromises.chmod(recorderInstalledPath, 0o755);
    await signBundle(recorderInstalledPath, "com.meetlify.app.recorder");
  }

  const helperBundles = [
    {
      path: path.join(applicationsPath, "Contents", "Frameworks", "Meetlify Helper.app"),
      identifier: "com.meetlify.app.helper",
    },
    {
      path: path.join(applicationsPath, "Contents", "Frameworks", "Meetlify Helper (Renderer).app"),
      identifier: "com.meetlify.app.helper.renderer",
    },
    {
      path: path.join(applicationsPath, "Contents", "Frameworks", "Meetlify Helper (GPU).app"),
      identifier: "com.meetlify.app.helper.gpu",
    },
    {
      path: path.join(applicationsPath, "Contents", "Frameworks", "Meetlify Helper (Plugin).app"),
      identifier: "com.meetlify.app.helper.plugin",
    },
  ];

  for (const helperBundle of helperBundles) {
    if (fs.existsSync(helperBundle.path)) {
      await signBundle(helperBundle.path, helperBundle.identifier);
    }
  }

  await execFileAsync("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    "--identifier",
    "com.meetlify.app",
    applicationsPath,
  ]);
};

const installPackagedApp = async (_forgeConfig, { outputPaths }) => {
  const packagedAppPath = resolvePackagedAppPath(outputPaths);
  const applicationsPath = path.join("/Applications", "Meetlify.app");
  const legacyWorkspaceCopyPath = path.resolve(__dirname, "..", "..", "Meetlify.app");

  await fsPromises.rm(applicationsPath, { recursive: true, force: true });

  try {
    await fsPromises.rename(packagedAppPath, applicationsPath);
  } catch (error) {
    if (error && error.code !== "EXDEV") {
      throw error;
    }

    await fsPromises.cp(packagedAppPath, applicationsPath, { recursive: true });
    await fsPromises.rm(packagedAppPath, { recursive: true, force: true });
  }

  await fsPromises.rm(legacyWorkspaceCopyPath, { recursive: true, force: true });
  await signInstalledApp(applicationsPath);
};

module.exports = {
  installPackagedApp,
};
