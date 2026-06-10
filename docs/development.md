# droid-webscr Development Baseline

## Quality Gates

Run these commands before committing any implementation task:

1. `pnpm lint-fix`
2. `pnpm format`
3. `pnpm type-check`
4. `pnpm test`
5. `pnpm test:coverage`
6. `pnpm build`
7. `pnpm android:check`
8. `pnpm android:build`
9. `pnpm android:emulator:verify`

All commands must complete without warnings. `pnpm android:emulator:verify` requires an online Android emulator; USB or network devices do not satisfy the emulator-backed acceptance check.

## Local Startup

Run `pnpm dev:app` to build the Android server artifact, prepare the agent `dist` entrypoint, and start the web dev server, agent watch build, and agent runtime together.

## Security Defaults

- The agent binds to `127.0.0.1` by default.
- Non-local bind addresses require an explicit `authToken` in config validation and runtime startup.
- When `authToken` is configured, non-health HTTP APIs require `Authorization: Bearer <authToken>` before session tokens are issued.
- WebSocket upgrades are authorized by the short-lived device-bound session token that was issued by the authenticated HTTP API.
- WebSocket sessions require the `droid-webscr.v1` subprotocol.
- WebSocket `Host` and `Origin` are checked independently from authentication before session traffic is accepted. Browser `Origin` must match the request `Host`.
- Session tokens are short-lived, device-bound, and reused for duplicate create requests while still valid.
- Concurrent session creation for the same device is serialized so only one active session token is minted per device policy window.
- Clipboard is disabled by default. Clipboard contents must not be logged, and clipboard UI remains disabled until explicit session capabilities are implemented.

## Video and Control Notes

- Android product verification requires Android-origin display content through `ShellDisplayCaptureBackend` into `MediaCodecVideoEncoder`; raw diagnostic video sources must not satisfy product acceptance.
- Browser video decode uses WebCodecs through a typed adapter boundary.
- H.264 config handling distinguishes `avcC` from Annex B. Annex B SPS/PPS config omits `VideoDecoderConfig.description`; `avcC` passes the description through.
- Pointer coordinates are mapped to Android's exclusive display bounds: `0..width-1` and `0..height-1`.
- Text and IME input are captured through a hidden `textarea` boundary and emitted as `CONTROL_TEXT`.

## Known Limitations

- The Android server is currently a shell-launched artifact pushed to `/data/local/tmp` and started with `app_process`.
- Hidden Android display and input APIs vary by emulator image and Android version. Platform-specific behavior must stay behind adapter boundaries and be verified with an emulator.
- Chromium-family browsers are the first-class WebCodecs target. Unsupported browsers should show a non-crashing unsupported state.
- Multi-device behavior is covered by fake-provider tests unless multiple live emulators are available locally.
