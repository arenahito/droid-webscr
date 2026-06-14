# droid-webscr

droid-webscr is a local Android screen streaming and control tool. It runs a local
Node.js server on your machine, pushes a temporary Android-side server through ADB,
and serves a browser UI for viewing and controlling an authorized Android device.

The project is under active development. Expect CLI and protocol details to keep
moving until the first stable release.

## Features

- Browser-based Android screen viewing with WebCodecs.
- Pointer, keyboard, text, and Android hardware-button control.
- USB, emulator, and network ADB device discovery.
- Device log viewing and live log tailing.
- Runtime bind controls for local or authenticated shared access.
- Android server verification backed by emulator acceptance checks.

## Installation

```sh
npm install -g @arenahito/droid-webscr
```

You can also run it without installing it globally:

```sh
npx @arenahito/droid-webscr
```

The installed command is:

```sh
droid-webscr
```

## Prerequisites

- Node.js 24 or newer.
- Android SDK platform-tools with `adb` available on `PATH`.
- An Android emulator or device visible in `adb devices -l`.
- Device authorization completed when using a physical Android device.
- Chrome or Edge for the browser UI.

## Usage

Start the local agent and local-only web UI:

```sh
droid-webscr
```

By default the agent API listens on `127.0.0.1:7391`, and the web UI is served
only to local browser requests:

```text
Web UI: http://127.0.0.1:7391
Agent API: http://127.0.0.1:7391
```

Open the printed Web UI URL, select an authorized device, and start a session.
The session streams the Android display into the browser and sends control frames
back to the device through the local agent.

You can choose the agent API port:

```sh
droid-webscr --port 7400
```

Use `--host` when another local process or a trusted machine must reach the agent
API or WebSocket endpoint. This does not publish the web UI to that host; the web
UI stays local-only.

```sh
droid-webscr --host 0.0.0.0 --port 7400
```

Authentication is always enabled. If `--auth-token` is not provided, droid-webscr
generates a cryptographically random process-local token and prints it at startup.
Pass a token explicitly when you need another process to connect to the same
agent:

```sh
droid-webscr --host 0.0.0.0 --port 7400 --auth-token secret
```

Use `--agent-url` to start a local-only web UI that connects to an existing agent
instead of starting a new Android agent:

```sh
droid-webscr --agent-url http://127.0.0.1:7400 --port 7401 --auth-token secret
```

The UI supports:

- starting and stopping a device session;
- selecting video bitrate and frame rate;
- pointer, keyboard, and text input;
- back, home, overview, power, and volume actions;
- rotation controls;
- device log history and live log tailing;
- connecting a network ADB endpoint such as `192.168.1.40:5555`.

## Configuration

droid-webscr starts with local-only defaults. The agent API listens on
`127.0.0.1:7391`, the web UI accepts local browser requests only, and clipboard
sync is disabled.

Runtime access settings can be changed from the web UI. The CLI always supplies
an auth token to the agent, including when it generates one automatically. Non-
local agent binds are intended for trusted networks only, and clipboard sync must
be enabled explicitly.

## License

MIT
