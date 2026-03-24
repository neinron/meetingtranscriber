const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const { installPackagedApp } = require("./scripts/post-package");

module.exports = {
  hooks: {
    postPackage: installPackagedApp,
  },
  packagerConfig: {
    name: "Meetlify",
    executableName: "Meetlify",
    appBundleId: "com.meetlify.app",
    helperBundleId: "com.meetlify.app.helper",
    icon: "assets/icon/icon",
    extraResource: ["src/swift/Recorder"],
    extendInfo: {
      NSMicrophoneUsageDescription: "Meetlify needs microphone access to record your meetings.",
    },
    extendHelperInfo: {
      NSMicrophoneUsageDescription: "Meetlify needs microphone access to record your meetings.",
    },
    asar: {
      unpack: "src/swift/Recorder",
    },

    // Local builds are unsigned by default; add signing/notarization in CI/release config.
    osxSign: {
      identity: "-",
    },
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
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
