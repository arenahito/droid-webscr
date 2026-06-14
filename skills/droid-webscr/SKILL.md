---
name: droid-webscr
description: Use an npm-installed droid-webscr CLI to expose an Android device or emulator in a local-only browser UI, then verify Android workflows with an AI agent's browser automation tools. Use when an agent needs to run `droid-webscr` or `npx @arenahito/droid-webscr`, optionally pass `--host`, `--port`, `--auth-token`, or `--agent-url`, open the printed Web UI URL, view the live Android screen, operate the device with browser clicks/keyboard/text input/hardware controls, collect screenshots or logs, and confirm Android-facing behavior through the browser control path.
---

# droid-webscr

Use this skill when the user wants an AI agent to test an Android device, emulator, or Android app through the droid-webscr browser UI. Assume droid-webscr is an installed npm tool, and keep the workflow centered on the CLI, the local browser UI, and the connected Android target.

## Workflow

1. Confirm the installed-tool prerequisites.
2. Start droid-webscr with the CLI.
3. Open the `Web UI:` URL printed by droid-webscr.
4. Select an authorized Android target.
5. Start a browser session and wait for live Android video.
6. Operate the Android screen through the browser UI.
7. Capture concise evidence and stop the session when finished.

## Prerequisites

Confirm or help establish only the pieces a normal tool user needs:

- Node.js 24 or newer.
- Android SDK platform-tools with `adb` available on `PATH`.
- A visible Android emulator, USB device, or network device in `adb devices -l`.
- User-approved Android authorization for physical devices.
- Chrome, Edge, or another Chromium-family browser with WebCodecs support.

If something is missing, name the missing capability and give the smallest next setup step. Do not switch to a different testing approach unless droid-webscr cannot run.

## Start droid-webscr

Use the installed command when available:

```sh
droid-webscr
```

If the command is not available and package execution is acceptable:

```sh
npx @arenahito/droid-webscr
```

Use `--port` when the default is occupied, and `--host` when the agent API must listen on a non-default address:

```sh
droid-webscr --port 7400
droid-webscr --host 0.0.0.0 --port 7400
```

Use `--auth-token` only when the token must be stable or shared with another droid-webscr process. Otherwise the CLI generates a process-local token automatically.

Use `--agent-url` to open a local-only Web UI for an already running droid-webscr agent:

```sh
droid-webscr --agent-url http://127.0.0.1:7400 --port 7401 --auth-token secret
```

Keep the CLI process running while testing. Open the `Web UI:` URL printed by the CLI. The default is:

```text
http://127.0.0.1:7391/
```

The Web UI is local-only even when `--host 0.0.0.0` exposes the agent API. Treat `--host` as the agent API bind address, not as permission to publish the browser UI.

If the port is already in use, identify the conflict before asking to stop anything. Avoid stopping unrelated user processes without permission.

## Browser Operation

Use browser automation for the droid-webscr web UI:

- Navigate to the printed `Web UI:` URL.
- Wait for the device list to load.
- Select the intended device by model or serial.
- Keep default video settings unless bitrate or frame rate matters to the test.
- Start the session.
- Wait for `Video ready`, `Receiving Android video`, or a visibly live Android screen.
- Click Android controls through the video canvas.
- Type with the browser keyboard path when text input is part of the test.
- Use the UI hardware controls for Back, Home, Overview, Power, volume, and rotation actions.
- Stop the session at the end unless the user asks to leave it running.

Prefer visible Android state, screen transitions, UI text, and device logs as assertions. A loaded droid-webscr page is not enough; the test should prove the Android screen is live and controllable from the browser.

## ADB Usage

Use ADB only as support for the browser-driven flow:

- Check device visibility with `adb devices -l`.
- Confirm whether a device is unauthorized, offline, or missing.
- Diagnose Android-side startup, capture, or encoder failures when the browser UI cannot show live video.

Do not use ADB as the primary interaction path when the task is to verify behavior through droid-webscr.

## Evidence

Collect only evidence that helps the user trust the browser-driven result:

- The CLI command used.
- The `Web UI:` URL opened.
- The `Agent API:` URL when it differs from the Web UI URL.
- The selected device model or serial.
- Screenshots before and after meaningful Android interactions.
- Relevant droid-webscr status text.
- Short device log excerpts when logs explain the tested behavior or failure.
- Terminal errors only when they explain why the browser flow failed.

Summarize large logs instead of pasting them wholesale.

## Failure Triage

- `droid-webscr` command not found: use `npx @arenahito/droid-webscr` if allowed, or ask the user to install with `npm install -g @arenahito/droid-webscr`.
- No devices listed: check `adb devices -l`, start the emulator or connect the device, and ask the user to approve Android authorization when prompted.
- Device visible but session fails: inspect the browser status, CLI output, and device logs; address the cause before retrying.
- Canvas stays in a waiting state: confirm Chromium/WebCodecs support, device authorization, and Android-side capture or encoder health.
- Browser clicks miss the Android target: take a screenshot and account for canvas scaling, rotation, and letterboxing before retrying.
- Network ADB endpoint not listed: use the UI endpoint connection flow when available, or use ADB just enough to make the device visible.
