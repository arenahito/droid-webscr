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

Start the local server and web UI:

```sh
droid-webscr
```

By default the integrated server listens on:

```text
http://127.0.0.1:7391
```

Open the printed URL, select an authorized device, and start a session. The session
streams the Android display into the browser and sends control frames back to the
device through the local server.

The UI supports:

- starting and stopping a device session;
- selecting video bitrate and frame rate;
- pointer, keyboard, and text input;
- back, home, overview, power, and volume actions;
- rotation controls;
- device log history and live log tailing;
- connecting a network ADB endpoint such as `192.168.1.40:5555`.

## Configuration

droid-webscr currently starts with local-only defaults. The agent listens on
`127.0.0.1:7391`, and clipboard sync is disabled.

Runtime access settings can be changed from the web UI. Non-local bind addresses
require an auth token, and clipboard sync must be enabled explicitly.

## License

MIT
