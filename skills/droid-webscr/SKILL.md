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
- Prefer stable automation attributes over DOM text parsing for Web UI controls:
  - Use `[data-control-id="device.select"][data-device-serial="<serial>"]` to select a device.
  - Use `[data-control-id="session.start"]` and `[data-control-id="session.stop"]` to start and stop sessions.
  - Use `[data-control-id="device.refresh"]` and `[data-control-id="device.connectEndpoint"]` for device discovery.
  - Use `[data-control-id="android.back"]`, `android.home`, `android.overview`, `android.power`, `android.volumeUp`, `android.volumeDown`, `android.rotateLeft`, `android.rotateRight`, and `android.keyEvent` for Android hardware controls.
  - Use `[data-control-id="android.capture"]` to capture the latest decoded Android frame and copy it directly to the clipboard as `image/png`.
  - Use `[data-control-id="log.expand"]`, `log.collapse`, `log.start`, `log.stop`, and `log.clear` for device-log controls.
  - Fall back to accessible role/name queries only when a stable control ID is not present.
- Keep default video settings unless bitrate or frame rate matters to the test.
- Start the session.
- Wait for `Video ready`, `Receiving Android video`, or a visibly live Android screen.
- Treat `Video ready` and `Receiving Android video` as supporting evidence only. They do not prove the Android app workflow by themselves.
- Confirm Android app behavior in the Android screen area, not in the surrounding Web UI or log drawer:
  - Inspect `[data-control-id="android.viewport"]` for the framed Android display area.
  - Use `[data-control-id="android.videoCanvas"]` as the input surface for Android app taps, drags, keyboard focus, and cropped visual checks.
  - Android app buttons and text are pixels inside the video canvas, not Web DOM nodes. Do not parse the Web DOM to find Android app controls.
  - When clicking inside Android, compute coordinates relative to the video canvas and account for scaling, rotation, and letterboxing.
- Prefer the built-in still-capture flow for visual evidence after Android video is ready:
  1. Click `[data-control-id="android.capture"]`.
  2. Wait for `[data-control-id="android.captureStatus"]` to progress from `Capturing PNG` to `Copying PNG`, then `PNG copied`.
  3. Read the clipboard item and require MIME type `image/png` before using it as Android visual evidence.
  4. Repeat Capture before every read so stale clipboard content is never treated as the current Android screen.
- Clipboard permission is a user-controlled boundary. If the status remains `Copying PNG`, a clipboard permission prompt appears, or the clipboard has no `image/png` item:
  1. Stop the workflow immediately.
  2. Do not take an independent page screenshot, crop `android.videoCanvas`, invent a download fallback, or repeatedly click Capture.
  3. Ask the user to allow clipboard access in the in-app browser and tell you when permission has been granted.
  4. After the user confirms, first allow the pending copy to finish. If it does not finish, click Capture once and re-check `android.captureStatus` and the `image/png` clipboard item.
- If capture reports an explicit clipboard error instead of waiting for permission, report the error and stop. Use another capture path only when the user explicitly authorizes that fallback.
- The captured PNG contains only the current decoded `android.videoCanvas` frame at its backing resolution. It does not include the phone frame, hardware rail, status labels, or device log.
- Convert a target found in the captured PNG to browser coordinates before every pointer action:
  1. Read the current PNG width and height.
  2. Immediately before the action, read the latest bounding rectangle of `[data-control-id="android.videoCanvas"]`.
  3. Convert the PNG target independently on each axis:

     ```text
     browserX = canvasLeft + pngX / pngWidth * canvasWidth
     browserY = canvasTop  + pngY / pngHeight * canvasHeight
     ```

  4. Confirm the PNG target is inside the PNG and the converted point is inside the current canvas rectangle.
  5. Click the converted browser point once.

- Never reuse a canvas rectangle after browser resize, sidebar or log-drawer changes, device rotation, video reconfiguration, session restart, or any layout change. Read it again even when the PNG dimensions are unchanged.
- Use separate horizontal and vertical scale factors. Do not assume uniform scaling or use the phone shell, viewport frame, page screenshot, or hardware rail as the coordinate origin.
- Treat a capture made during animation, loading, keyboard appearance, or app launch as an intermediate frame:
  1. Do not choose the next target from an incomplete transition frame.
  2. Wait for the expected Android state to become visibly settled.
  3. Capture again and use only the settled PNG for the next coordinate calculation.
- After each pointer action, Capture again and confirm the expected visible result before continuing. A changed PNG proves only that a frame changed; inspect the Android state to prove the intended control was activated.
- Keep text input separate from pointer-coordinate mapping. Focus the intended Android field with a converted canvas click, use the browser keyboard path through `Android text input`, then Capture and verify the entered text or resulting screen. If text is absent, stop and diagnose the input path instead of assuming the coordinate click failed or continuing with Enter/submit.
- Use `Ctrl`/`Cmd` + mouse drag on `[data-control-id="android.videoCanvas"]` for a synthetic two-finger pinch:
  - The gesture is available only after the session is started and Android control is ready.
  - Mouse down sends two touch-down points immediately: the cursor-side point and the point reflected across the viewport center anchor.
  - Mouse move sends both points as a multi-touch move. The move-start threshold remains in the implementation but is currently set to `0`, so the first move is sent immediately.
  - If either touch point would fall outside the Android viewport, that move is skipped and the last valid touch points are retained for release.
  - Drag away from the center anchor to pinch out; drag toward the center anchor to pinch in.
  - During the gesture, the Cyan Guide overlay shows the cursor-side point, reflected point, center anchor, and guide line. The overlay is hidden when Android control is not ready.
- Type with the browser keyboard path when text input is part of the test.
- Use the UI hardware controls for Back, Home, Overview, Power, volume, and rotation actions.
- Stop the session at the end unless the user asks to leave it running.

Prefer visible Android state in the video canvas, screen transitions, UI text inside the Android viewport, and device logs as assertions. A loaded droid-webscr page or a ready status label is not enough; the test should prove the Android screen is live and controllable from the browser.

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
- PNGs copied by the built-in Capture flow for Android-only visual evidence.
- Page or viewport screenshots when the surrounding droid-webscr status, phone frame, overlays, or logs are part of the assertion.
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
