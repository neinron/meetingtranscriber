const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const { copyPackagedAppToMainFolder } = require("./scripts/post-package");

module.exports = {
  hooks: {
    postPackage: copyPackagedAppToMainFolder,
  },
  packagerConfig: {
    name: "Meetlify",
    executableName: "Meetlify",
    icon: "assets/icon/icon",
    extraResource: ["src/swift/Recorder"],
    asar: {
      unpack: "src/swift/Recorder",
    },

    // Local builds are unsigned by default; add signing/notarization in CI/release config.
    osxSign: false,
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-pkg",
      config: {},
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
