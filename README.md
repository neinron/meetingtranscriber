# Meetlify

Meetlify is a macOS desktop transcription app built with Electron and Swift. It records system audio and optional microphone input into a single FLAC file, lets you review recordings inside the app, sends recordings to Gemini for diarized transcription, and stores editable transcript markdown in a dedicated app data folder.

## What It Does

- Captures system audio on macOS using the bundled Swift recorder.
- Optionally mixes microphone input into the same recording session.
- Shows live system and mic level meters while recording.
- Stores recordings and transcripts in the app support directory instead of scattering files across the project.
- Provides an in-app player for previously recorded sessions.
- Generates diarized transcripts with Gemini.
- Opens transcripts in a built-in markdown editor with search, replace, preview, and save.
- Exposes tray controls for opening the app and starting or stopping recording.

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
- `src/electron/utils/gemini.js`
  Gemini upload, transcript generation, metadata generation, transcript shaping.
- `src/electron/utils/playback.js`
  Generates WAV previews from FLAC recordings for the embedded player.
- `src/electron/utils/paths.js`
  Application paths, storage directories, packaged recorder extraction.
- `src/swift/Recorder.swift`
  Native recorder implementation.
- `assets/icon/`
  Packaged macOS icon assets.

## Requirements

- macOS with ScreenCaptureKit support.
- Node.js and npm.
- Xcode command line tools.
- A Gemini API key.

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

## Application Storage

Meetlify uses Electron's `app.getPath("userData")` as the base storage location.

Typical paths on macOS:

- Recordings: `~/Library/Application Support/Meetlify/storage/recordings`
- Transcripts: `~/Library/Application Support/Meetlify/storage/transcripts`
- Extracted packaged recorder binary: `~/Library/Application Support/Meetlify/bin/Recorder`

The exact location follows the active Electron app identity and packaging context.

## Recording Workflow

1. Launch Meetlify.
2. Confirm the recordings and transcripts folders shown in the UI.
3. Enter or keep the generated filename.
4. Pick a microphone, or leave it as `No microphone`.
5. Start recording.
6. Stop recording when finished.
7. Select the recording from the list.
8. Process it with Gemini.
9. Review and edit the transcript.
10. Save the transcript markdown.

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

### Recordings Section

- Lists saved FLAC recordings.
- Shows file metadata.
- Prepares a playback preview automatically when needed.
- Lets you choose the Gemini model before processing.

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

### Tray Icon or Menu Looks Stale

Quit the app fully and relaunch it. Packaged builds are a better signal than long-lived development sessions when checking tray behavior.

## Known Gaps

- No automated test suite is currently included.
- The renderer still uses `nodeIntegration` and CDN-loaded Tailwind.
- Packaging currently emits non-blocking Node `DEP0174` deprecation warnings under newer Node versions.
- Signing, notarization, and release entitlements are not yet configured.

## License

MIT
