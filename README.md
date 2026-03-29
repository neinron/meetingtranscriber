# Meetlify

Meetlify is a macOS desktop app for recording meetings, reviewing recordings, generating transcripts with Gemini, and editing those transcripts as Markdown.

It is built with:

- Electron for the desktop app shell
- a bundled Swift recorder for system audio and optional microphone capture
- Gemini for transcript generation

The app is designed around three working modes:

- `Recording Mode`
- `Editing Mode`
- `System Prompt Mode`

## Features

- Record macOS system audio
- Optionally include microphone input in the same recording
- Keep recording running when the app is hidden, minimized, or unfocused
- Browse recordings in an in-app library
- Play recordings inside the app
- Generate transcripts with Gemini
- Edit transcripts as Markdown with:
  - undo / redo
  - search / replace
  - speaker relabeling
  - live preview
- Save transcripts manually from the editor
- Export recordings to MP3 as:
  - a single file
  - chunked files
- Edit the transcription system prompt from inside the app
- Manage theme, permissions, API key, and storage folders from settings
- Control recording from the menu bar

## Storage

By default Meetlify stores user files in:

- `~/Documents/Meetlify/Recordings`
- `~/Documents/Meetlify/Transcripts`

Notes:

- recordings and transcripts are managed internally with stable ids
- a transcript file is only created when:
  - you transcribe a recording
  - or you manually save transcript content from the editor

Optional environment overrides:

- `MEETLIFY_STORAGE_ROOT`
- `MEETLIFY_RECORDINGS_DIR`
- `MEETLIFY_TRANSCRIPTS_DIR`

## Requirements

- macOS with ScreenCaptureKit support
- Node.js and npm
- Xcode command line tools
- `ffmpeg`
- a Gemini API key

`ffmpeg` is used for:

- MP3 export

## Setup

Install dependencies and build the native recorder:

```bash
npm install
npm run swift:make
```

Provide a Gemini API key either through the app settings or through `.env`:

```env
GEMINI_API_KEY=your_key_here
```

## Development

Start the app in development mode:

```bash
npm run electron:start
```

Notes:

- changes in renderer files such as `screen.html` and `renderer.js` usually only need a window reload
- changes in `main.js` require a full app restart
- changes in `src/swift/Recorder.swift` require:

```bash
npm run swift:make
```

and then a full app restart

## Docker Workflow

This repository now includes a small Docker-based tooling environment:

```bash
npm run docker:build
npm run docker:shell
```

Use it for repeatable repo tooling such as inspecting files, running generic Node scripts, and using `ffmpeg` in a clean container.

The npm scripts automatically use `docker compose` when available and fall back to `docker-compose` on older installations.

Important limitation:

- the actual app runtime is still macOS-only
- ScreenCaptureKit, Electron packaging for macOS, and `swiftc` builds of `src/swift/Recorder.swift` must run on the macOS host
- do not treat the container as a replacement for the native app environment

## Packaging

Build a packaged app bundle:

```bash
npm run electron:package
```

This produces a runnable `.app` bundle in the local build output.

The repository still contains a universal `electron:make` script:

```bash
npm run electron:make
```

but in this project that flow may need extra packaging adjustments depending on the target architecture and bundled native recorder.

## Permissions

Meetlify needs:

- `System Audio` / Screen Recording permission to capture macOS output audio
- Microphone permission if microphone capture is enabled

## Audio Pipeline

The recording path now mirrors the core approach used in `meetily` more closely:

- system audio and microphone are captured independently at 48 kHz
- the final merge happens in-process in Swift
- the mixer applies fixed headroom and a simple limiter to avoid the clipping that a raw `amix` pass can introduce
- `ffmpeg` remains an export dependency for MP3 output, not for the core recording path

The app exposes permission actions in the settings panel.

## Transcript Workflow

When you transcribe a recording, Meetlify:

1. uploads the selected audio file to Gemini
2. requests a transcript
3. saves the result as Markdown
4. opens the result in the editor

The generated transcript format includes:

- the recording file name as the title
- a date line with date, start time, and end time
- transcript content in Markdown

## UI Overview

The app uses a custom desktop interface with:

- a collapsible, resizable sidebar
- a recording setup view
- a review / editing workspace
- a dedicated system-prompt editor
- light, dark, and system theme modes

## Menu Bar

While Meetlify is running, the menu bar item can:

- open the app
- show recording state
- stop or inspect an active recording

When recording is active, the menu bar status updates live.

## Attribution

This app includes Swift recording code derived from work by Luke Lucas (`O4FDev`), used under the MIT License.

Copyright (c) 2024 Luke Lucas
