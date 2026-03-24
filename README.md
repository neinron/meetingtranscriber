# Meetlify

Meetlify is a macOS desktop transcription app built with Electron and Swift. It records system audio and optional microphone input into a single FLAC file, lets you review recordings inside the app, sends recordings to Gemini for diarized transcription, and stores editable transcript markdown in a dedicated app data folder.

The project is now set up so a new user can understand the important folders quickly:

- source code stays in the repo
- user recordings and transcripts default to visible folders in `~/Documents/Meetlify`
- packaged builds are copied to the parent `MeetingTranscriber` folder as `Meetlify.app`

## What It Does

- Captures system audio on macOS using the bundled Swift recorder.
- Optionally mixes microphone input into the same recording session.
- Shows live system and mic level meters while recording.
- Stores recordings and transcripts in the app support directory instead of scattering files across the project.
- Provides an in-app player for previously recorded sessions.
- Exports selected recordings as MP3.
- Optionally splits MP3 exports into AI-upload-friendly chunks under 90 MB each.
- Generates diarized transcripts with Gemini.
- Opens transcripts in a built-in markdown editor with search, replace, preview, and save.
- Exposes tray controls for opening the app and starting or stopping recording.
- Uses a square `M` menu bar icon instead of the old generic tray asset.

## Tech Stack

- Electron for the desktop shell and UI.
- Swift for the native recorder binary.
- Gemini API for transcription and metadata generation.
- Plain renderer JavaScript with Tailwind loaded from CDN.

## Repository Layout

- `src/electron/main.js`
  Main Electron process, tray logic, window setup, IPC, permission flow.
- `src/electron/screens/recording/`
  Main application UI for recording, playback, and transcript editing.
- `src/electron/screens/permission-denied/`
  Fallback screen shown when screen recording permission is unavailable.
- `src/electron/utils/recording.js`
  Recorder process lifecycle, stdout parsing, device listing, recording state events.
- `src/electron/utils/export.js`
  MP3 export and optional chunked export for AI chatbot upload workflows.
- `src/electron/utils/gemini.js`
  Gemini upload, transcript generation, metadata generation, transcript shaping.
- `src/electron/utils/playback.js`
  Generates WAV previews from FLAC recordings for the embedded player.
- `src/electron/utils/paths.js`
  Application paths and configurable user-facing storage directories.
- `scripts/post-package.js`
  Copies the packaged `.app` bundle into the parent `MeetingTranscriber` folder.
- `src/swift/Recorder.swift`
  Native recorder implementation.
- `assets/icon/`
  Packaged macOS icon assets.

## Requirements

- macOS with ScreenCaptureKit support.
- Node.js and npm.
- Xcode command line tools.
- A Gemini API key.
- FFmpeg installed on the Mac for MP3 export.

## Installation

1. Install dependencies:

```bash
npm install
```

2. Build the Swift recorder:

```bash
npm run swift:make
```

3. Create an environment file:

```bash
cp .env.example .env
```

4. Add your Gemini API key:

```env
GEMINI_API_KEY=your_key_here
```

## First-Time Configuration

For a new user, the simplest setup is:

1. Copy `.env.example` to `.env`
2. Set `GEMINI_API_KEY`
3. Keep the default storage root unless you want a different location
4. Build the Swift recorder
5. Start the app

Configuration values supported in `.env`:

- `GEMINI_API_KEY`
  Required for transcript generation.
- `MEETLIFY_STORAGE_ROOT`
  Default root for user files. Defaults to `~/Documents/Meetlify`.
- `MEETLIFY_RECORDINGS_DIR`
  Recordings folder. Relative values are resolved inside `MEETLIFY_STORAGE_ROOT`.
- `MEETLIFY_TRANSCRIPTS_DIR`
  Transcripts folder. Relative values are resolved inside `MEETLIFY_STORAGE_ROOT`.
- `MEETLIFY_MP3_BITRATE_KBPS`
  MP3 export bitrate. Default is `96`.
- `MEETLIFY_MP3_CHUNK_SIZE_MB`
  Chunk size target for AI-upload exports. Default is `90`.

Recommended default for most users:

- recordings in `~/Documents/Meetlify/Recordings`
- transcripts in `~/Documents/Meetlify/Transcripts`
- packaged app at `/Users/jaronschurer/Coding/MeetingTranscriber/Meetlify.app`

## Development Run

Start the app in development mode:

```bash
npm run electron:start
```

What to expect on first launch:

- macOS may prompt for Screen Recording permission.
- If you enable microphone recording, macOS may also prompt for Microphone permission.
- The app will create its storage directories automatically under the app data location.

## Packaging

Build a packaged macOS app bundle:

```bash
npm run electron:package
```

The packaged app is written to:

- `out/Meetlify-darwin-arm64/Meetlify.app`

After packaging, Meetlify also copies the app bundle to the parent workspace folder:

- `/Users/jaronschurer/Coding/MeetingTranscriber/Meetlify.app`

## Application Storage

Meetlify now defaults to a visible user-facing storage location instead of burying files inside app support.

Typical paths on macOS:

- Recordings: `~/Documents/Meetlify/Recordings`
- Transcripts: `~/Documents/Meetlify/Transcripts`

If you override the env config, those paths will change accordingly.

## Recording Workflow

1. Launch Meetlify.
2. Confirm the recordings and transcripts folders shown in the UI.
3. Enter or keep the generated filename.
4. Pick a microphone, or leave it as `No microphone`.
5. Start recording.
6. Stop recording when finished.
7. Select the recording from the list.
8. Optionally export it as MP3.
9. Enable chunking if you want files sized for AI chatbot uploads.
10. Process it with Gemini.
11. Review and edit the transcript.
12. Save the transcript markdown.

## MP3 Export Workflow

When exporting a recording as MP3:

- Meetlify converts the selected FLAC file to MP3 with FFmpeg.
- The MP3 is written next to the original recording in the recordings folder.
- If chunking is enabled, Meetlify creates a sibling folder named `<recording-name>-mp3-chunks`.
- Chunked exports are sized with a safety margin so each file stays under the 90 MB upload target.

Export file naming:

- Single export: `meeting-name.mp3`
- Chunked export folder: `meeting-name-mp3-chunks/`
- Chunk files: `meeting-name.part001.mp3`, `meeting-name.part002.mp3`, and so on

## Transcript Workflow

When a recording is processed:

- The FLAC file is uploaded to Gemini.
- Meetlify requests a diarized transcript.
- The transcript is normalized into markdown.
- Meetlify asks Gemini for a short title and description.
- If metadata generation fails, the transcript is still returned with fallback meeting metadata.
- The transcript is written to a `.transcript.md` file in the transcripts directory.

Transcript file naming:

- Recording: `meeting-name.flac`
- Transcript: `meeting-name.transcript.md`

## Permissions

Meetlify relies on macOS privacy permissions.

### Screen Recording

Required for system audio capture.

If access is denied:

- the app may show the permission-denied screen
- starting a recording will fail
- the in-app permission button can re-check access

### Microphone

Required only if a microphone is selected.

If access is denied:

- microphone device listing can fail
- starting a recording with a selected mic will fail
- the app can direct you to the macOS microphone settings screen

macOS settings locations:

- `System Settings > Privacy & Security > Screen Recording`
- `System Settings > Privacy & Security > Microphone`

## UI Overview

### Recording Panel

- Start and stop the active recording session.
- Shows current state and elapsed time.
- Shows the output file path while recording.

### Recording Setup

- Recording filename input.
- Microphone selector.
- Recordings folder display and open action.
- Transcripts folder display and open action.
- Permission check actions.
- Live audio level meters.
- Overflow-safe path cards so long folder paths stay inside the UI cards.

### Recordings Section

- Lists saved FLAC recordings.
- Shows file metadata.
- Prepares a playback preview automatically when needed.
- Lets you choose the Gemini model before processing.
- Lets you export recordings as MP3.
- Lets you split MP3 exports into AI-upload-sized chunks.

### Transcript Editor

- Editable markdown source.
- Rendered preview pane.
- Search and replace controls.
- Save action for transcript files.

## Scripts

- `npm run swift:make`
  Builds the native Swift recorder binary at `src/swift/Recorder`.
- `npm run electron:start`
  Runs the app in development through Electron Forge.
- `npm run electron:package`
  Packages the app as a macOS app bundle.
- `npm run electron:make`
  Runs the Electron Forge make flow configured for macOS.

## Environment Variables

- `GEMINI_API_KEY`
  Required for transcript generation.
- `GEMINI_ENV_PATH`
  Set internally after env loading so runtime errors can point to the loaded env file.

Meetlify searches for `.env` in a few places, including the project directory and the app data directory.

## Icon Assets

The packaged app icon is generated from:

- `/Users/jaronschurer/Coding/MeetingTranscriber/AppIcon.png`

Derived assets live in:

- `assets/icon/AppIcon.png`
- `assets/icon/icon.iconset/`
- `assets/icon/icon.icns`

## Troubleshooting

### `ENOENT package.json`

Run npm commands from:

- `/Users/jaronschurer/Coding/MeetingTranscriber/electron-system-audio-recorder`

### Recording Will Not Start

Check:

- Screen Recording permission is granted.
- The recordings directory is writable.
- The requested filename does not already exist.
- The Swift recorder binary has been built with `npm run swift:make`.

### No Microphones Are Listed

Check:

- Microphone permission is granted.
- The app has been restarted after changing permission state.

### Playback Fails

Meetlify generates a WAV preview from the FLAC recording for in-app playback. Playback can fail if:

- the recording file is empty or invalid
- macOS audio conversion fails
- the preview file could not be generated

### Transcript Processing Fails

Check:

- `GEMINI_API_KEY` is present in `.env`
- network access is available
- the selected recording is valid and non-empty

### MP3 Export Fails

Check:

- FFmpeg is installed and available at `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, or in `PATH`
- the selected recording is valid and non-empty
- the recordings directory is writable

### I Cannot Find My Files

By default, look here:

- `~/Documents/Meetlify/Recordings`
- `~/Documents/Meetlify/Transcripts`

If those are not the right folders, check your `.env` overrides for:

- `MEETLIFY_STORAGE_ROOT`
- `MEETLIFY_RECORDINGS_DIR`
- `MEETLIFY_TRANSCRIPTS_DIR`

### Tray Icon or Menu Looks Stale

Quit the app fully and relaunch it. Packaged builds are a better signal than long-lived development sessions when checking tray behavior.

## Known Gaps

- No automated test suite is currently included.
- The renderer still uses `nodeIntegration` and CDN-loaded Tailwind.
- Packaging currently emits non-blocking Node `DEP0174` deprecation warnings under newer Node versions.
- Signing, notarization, and release entitlements are not yet configured.

## License

MIT
