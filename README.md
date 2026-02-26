# Scriby

Scriby is a macOS desktop app (Electron + Swift) for recording system audio and microphone audio, generating transcripts with Gemini, and editing transcripts in a built-in markdown editor.

## Core Features

- Record system audio and optional microphone input in one FLAC file
- Select microphone device before recording
- Live system/mic level meters during recording
- Tray (menu bar) controls for opening app and start/stop recording
- Recording playback for selected files
- Transcript generation via Gemini (`gemini-2.5-flash` / `gemini-2.5-pro`)
- Built-in transcript editor with search + replace workflow
- Central app storage for recordings and transcripts

## Requirements

- macOS (ScreenCaptureKit-capable system)
- Node.js + npm
- Xcode command line tools (for Swift compile)
- Gemini API key

## Installation

1. Install dependencies:

```bash
npm install
```

2. Build the Swift recorder binary:

```bash
npm run swift:make
```

3. Create environment file:

```bash
cp .env.example .env
```

4. Set your Gemini API key in `.env`:

```env
GEMINI_API_KEY=your_key_here
```

## Run (Development)

```bash
npm run electron:start
```

## Build App Bundle

```bash
npm run electron:package
```

Built app output:

- `out/Scriby-darwin-arm64/Scriby.app`

## macOS Permissions

Scriby requires:

- Screen Recording permission (for system audio capture)
- Microphone permission (if mic recording is enabled)

If devices or capture fail, check:

- `System Settings > Privacy & Security > Screen Recording`
- `System Settings > Privacy & Security > Microphone`

## Storage Locations

Scriby stores files under app support:

- Recordings: `~/Library/Application Support/scriby/storage/recordings`
- Transcripts: `~/Library/Application Support/scriby/storage/transcripts`

(Actual path follows Electron `app.getPath("userData")`.)

## Tray / Menu Bar

The menu bar item provides:

- Open Scriby
- Start/Stop recording
- Recording name
- Recording length
- Live level summary
- Stop Scriby

## Transcript Output Behavior

Gemini prompt is configured to return transcript-only output:

- No summary section
- No action items section

## Scripts

- `npm run swift:make` — compile Swift recorder binary
- `npm run electron:start` — run app in development
- `npm run electron:package` — package macOS app bundle
- `npm run electron:make` — run Electron Forge make flow

## Troubleshooting

- `ENOENT package.json`: run commands from this project folder.
- No microphone devices listed: ensure mic permission is granted for Scriby.
- Tray icon not updating: fully quit app and relaunch packaged build.
- Recording stops unexpectedly: verify permissions and avoid display/audio device changes during active capture.

## License

MIT
