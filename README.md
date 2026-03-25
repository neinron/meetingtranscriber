# Meetlify

Meetlify is a macOS menu bar meeting transcription app. It captures system audio with optional microphone input, stores recordings in a visible `~/Documents/Meetlify` folder, and uses Gemini to generate diarized meeting transcripts and summary metadata.

The menu bar item is a microphone icon. From there you can open the app, start or stop recording, and monitor the current recording state.

## What The App Does

- Records meeting audio on macOS through the bundled Swift recorder.
- Supports optional microphone capture in the same session.
- Stores recordings and transcripts in `~/Documents/Meetlify` by default.
- Lets you review recordings inside the app.
- Exports recordings to MP3.
- Processes recordings with Gemini only.
- Writes transcripts as editable Markdown files.

## Storage

Default user-facing folders:

- `~/Documents/Meetlify/Recordings`
- `~/Documents/Meetlify/Transcripts`

You can override these with:

- `MEETLIFY_STORAGE_ROOT`
- `MEETLIFY_RECORDINGS_DIR`
- `MEETLIFY_TRANSCRIPTS_DIR`

## Requirements

- macOS with ScreenCaptureKit support
- Node.js and npm
- Xcode command line tools
- FFmpeg for MP3 export
- A Gemini API key

## Setup

```bash
npm install
npm run swift:make
```

Create `.env` and add:

```env
GEMINI_API_KEY=your_key_here
```

Run in development:

```bash
npm run electron:start
```

Build the packaged app:

```bash
npm run electron:package
```

The packaged app bundle is also copied to:

- `/Users/jaronschurer/Coding/MeetingTranscriber/Meetlify.app`

## Notes

- Meetlify will ask for Screen Recording permission on first use.
- If microphone capture is enabled, macOS will also ask for Microphone permission.
- Transcripts are generated with Gemini models only.

## Changes

- Renamed the app source folder from `electron-system-audio-recorder` to `meetlify`.
- Rewrote this README as a clean product description instead of a legacy implementation document.
- Removed old “Electron system audio recorder” wording from the permission screen.
- Updated the menu bar item to use a microphone icon instead of the old `M` mark.
