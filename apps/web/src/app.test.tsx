import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  createFrameHeader,
  decodeFrame,
  encodeFrame,
  MessageType,
  StreamId,
} from "@droid-webscr/protocol";
import {
  createAgentEndpointUrl,
  createPhoneStyle,
  createSessionSocketUrl,
  DroidWebscrApp,
} from "./app.js";
import { createMemoryStorage } from "./lib/memory-storage.js";
import { VideoPipeline, VideoPipelineSnapshot } from "./decoder/video-pipeline.js";
import { FakeBinaryWebSocket, SessionSocket } from "./transport/session-socket.js";

describe("DroidWebscrApp", () => {
  it("sizes the phone against viewport padding and control rail placement", () => {
    expect(
      createPhoneStyle({ height: 1280, width: 720 }, { height: 360, width: 500 }, false),
    ).toMatchObject({
      "--phone-screen-aspect": "720 / 1280",
      height: "324px",
      width: "191px",
    });
    expect(
      createPhoneStyle({ height: 1280, width: 720 }, { height: 360, width: 500 }, true),
    ).toMatchObject({
      "--phone-screen-aspect": "720 / 1280",
      height: "266px",
      width: "158px",
    });
    expect(
      createPhoneStyle({ height: 1280, width: 720 }, { height: 200, width: 180 }, false),
    ).toMatchObject({
      height: "123px",
      width: "78px",
    });
    expect(
      createPhoneStyle({ height: 1280, width: 720 }, { height: 200, width: 180 }, true),
    ).toMatchObject({
      height: "106px",
      width: "68px",
    });
  });

  it("builds session websocket URLs from the active agent endpoint", () => {
    expect(createSessionSocketUrl("/ws/session/s1?token=t1", "")).toBe("/ws/session/s1?token=t1");
    expect(createSessionSocketUrl("/ws/session/s1?token=t1", "http://127.0.0.1:7400")).toBe(
      "ws://127.0.0.1:7400/ws/session/s1?token=t1",
    );
    expect(createSessionSocketUrl("/ws/session/s1?token=t1", "https://agent.example")).toBe(
      "wss://agent.example/ws/session/s1?token=t1",
    );
  });

  it("builds agent endpoint URLs without reusing wildcard share URLs", () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        hostname: "192.168.1.20",
        protocol: "http:",
      },
    });

    expect(createAgentEndpointUrl("0.0.0.0", 7400)).toBe("http://192.168.1.20:7400");
    expect(createAgentEndpointUrl("0.0.0.0", 7400, "http://10.0.0.5:7391")).toBe(
      "http://10.0.0.5:7400",
    );
    expect(createAgentEndpointUrl("::", 7400)).toBe("http://192.168.1.20:7400");
    expect(createAgentEndpointUrl("127.0.0.1", 7400)).toBe("http://127.0.0.1:7400");

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("uses restored agent endpoints on the frontend dev server", async () => {
    const storage = createMemoryStorage({
      "droid-webscr.agentEndpoint": "http://127.0.0.1:7400",
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:7400/api/devices") {
        return jsonResponse({ devices: [] });
      }
      if (url === "http://127.0.0.1:7400/api/config") {
        return jsonResponse({
          bindHost: "127.0.0.1",
          clipboardEnabled: true,
          port: 7400,
        });
      }
      if (url === "http://127.0.0.1:7400/api/share-url") {
        return jsonResponse({ url: "http://127.0.0.1:7400" });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DroidWebscrApp storage={storage} />);

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:7400/api/config", {
        headers: {},
      }),
    );
    expect(screen.getByText("Bind 127.0.0.1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle clipboard sync" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders empty device state and required operational regions", async () => {
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
        }}
        storage={createMemoryStorage()}
      />,
    );

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan adb devices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect by endpoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByLabelText("Android screen viewport")).toBeInTheDocument();
    const railButtons = screen
      .getByRole("navigation", { name: "Android hardware controls" })
      .querySelectorAll("button");
    expect([...railButtons].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Power",
      "Volume up",
      "Volume down",
      "Rotate left",
      "Rotate right",
      "Back",
      "Home",
      "Task list",
    ]);
    expect(screen.getByRole("button", { name: "Power" })).toHaveClass("danger");
    expect(screen.getByRole("button", { name: "Rotate right" })).not.toHaveClass("danger");
    expect(screen.queryByRole("button", { name: "Keyboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Task list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle clipboard sync" })).toBeEnabled();
    expect(screen.getByText("Bind 127.0.0.1")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Disconnected Android screen" })).toBeInTheDocument();
    expect(screen.queryByText("Wi-Fi 100%")).not.toBeInTheDocument();
    expect(screen.queryByText("Play Store")).not.toBeInTheDocument();
    expect(screen.queryByText("Mic Lens")).not.toBeInTheDocument();
    expect(
      document
        .querySelector<HTMLElement>(".phone-shell")
        ?.style.getPropertyValue("--phone-screen-aspect"),
    ).toBe("9 / 20");
  });

  it("shows scanning state and refresh errors from the agent", async () => {
    const user = userEvent.setup();
    let resolveDevices: ((devices: []) => void) | undefined;
    const client = {
      createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
      listDevices: () =>
        new Promise<[]>((resolve) => {
          resolveDevices = resolve;
        }),
    };
    render(<DroidWebscrApp client={client} storage={createMemoryStorage()} />);

    expect(await screen.findByText("Scanning devices")).toBeInTheDocument();
    resolveDevices?.([]);
    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();

    const failingClient = {
      ...client,
      listDevices: async () => {
        throw new Error("adb unavailable");
      },
    };
    cleanup();
    render(<DroidWebscrApp client={failingClient} storage={createMemoryStorage()} />);
    await user.click(await screen.findByRole("button", { name: "Scan adb devices" }));

    expect(await screen.findAllByText("adb unavailable")).toHaveLength(2);
    expect(screen.queryByRole("dialog", { name: "Scan adb devices" })).not.toBeInTheDocument();
  });

  it("keeps stale scan results out of the adb dialog after refresh failures", async () => {
    const user = userEvent.setup();
    let shouldFailRefresh = false;
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
          scanDevices: async () => {
            if (shouldFailRefresh) {
              throw new Error("adb unavailable");
            }
            return [
              {
                authorizationState: "authorized",
                model: "Pixel 8",
                serial: "emulator-5554",
                transportKind: "emulator",
              },
            ];
          },
        }}
        storage={createMemoryStorage()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Scan adb devices" }));
    const scanDialog = screen.getByRole("dialog", { name: "Scan adb devices" });
    expect(scanDialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect selected" })).toBeEnabled();
    expect(within(scanDialog).getByText("emulator-5554")).toBeInTheDocument();

    shouldFailRefresh = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("adb unavailable")).toBeInTheDocument();
    expect(within(scanDialog).queryByText("emulator-5554")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect selected" })).toBeDisabled();
  });

  it("uses fallback messages for non-Error failures", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => {
            throw "closed";
          },
          listDevices: async () => {
            throw "offline";
          },
        }}
        storage={createMemoryStorage()}
      />,
    );

    expect(await screen.findByText("Device listing failed")).toBeInTheDocument();
    cleanup();

    render(
      <DroidWebscrApp
        client={{
          createSession: async () => {
            throw "closed";
          },
          listDevices: async () => [{ authorizationState: "authorized", serial: "emulator-5554" }],
        }}
        storage={createMemoryStorage()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Android device emulator-5554" }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Session creation failed")).toBeInTheDocument();
  });

  it("starts and stops a selected device session", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    const createSession = vi.fn(async () => ({
      sessionId: "s-emulator",
      serial: "emulator-5554",
      token: "token-emulator",
    }));
    render(
      <DroidWebscrApp
        client={{
          createSession,
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
      />,
    );

    const device = await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(device);
    await user.selectOptions(screen.getByRole("combobox", { name: "Bitrate" }), "8");
    await user.selectOptions(screen.getByRole("combobox", { name: "FPS" }), "60");
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(createSession).toHaveBeenCalledWith("emulator-5554", { bitrateMbps: 8, fps: 60 });
    socket.open();
    expect(await screen.findByText("Session s-emulator")).toBeInTheDocument();
    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBeEnabled();
    expect(stopButton).toHaveClass("session-toggle", "session-running");
    expect(screen.getByRole("combobox", { name: "FPS" })).toBeDisabled();

    await user.click(stopButton);

    const startButton = screen.getByRole("button", { name: "Start" });
    expect(startButton).toBeEnabled();
    expect(startButton).toHaveClass("session-toggle");
    expect(startButton).not.toHaveClass("session-running");
    expect(screen.getByRole("combobox", { name: "FPS" })).toBeEnabled();
    expect(screen.queryByText("Session s-emulator")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Disconnected Android screen" })).toBeInTheDocument();
  });

  it("opens the binary session socket and sends video and system control frames", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    const pipeline = new FakeVideoPipeline({
      configured: true,
      decodedFrames: 1,
      droppedFrames: 0,
      lastError: undefined,
      pressure: false,
      status: "ready",
      videoSize: { height: 1280, width: 720 },
    });
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() => pipeline}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));

    expect(await screen.findByText("Video ready")).toBeInTheDocument();
    expect(pipeline.accepted).toHaveLength(1);
    expect(decodedType(socket.sent[0]!)).toBe(MessageType.SessionHello);
    expect(
      document
        .querySelector<HTMLElement>(".phone-shell")
        ?.style.getPropertyValue("--phone-screen-aspect"),
    ).toBe("720 / 1280");
    await user.click(screen.getByRole("button", { name: "Rotate right" }));
    expect(
      document
        .querySelector<HTMLElement>(".phone-shell")
        ?.style.getPropertyValue("--phone-screen-aspect"),
    ).toBe("720 / 1280");

    await user.click(screen.getByRole("button", { name: "Home" }));
    const home = decodeFrame(socket.sent[1]!);

    expect(home.ok && home.value.header.type).toBe(MessageType.ControlSystem);
    expect(home.ok && [...home.value.payload]).toEqual([1]);
    socket.receive(
      encodeFrame({
        header: createFrameHeader({
          payloadLength: new TextEncoder().encode("control:home:Accepted").byteLength,
          streamId: StreamId.Log,
          type: MessageType.LogRecord,
        }),
        payload: new TextEncoder().encode("control:home:Accepted"),
      }),
    );

    expect(await screen.findByText("control:home:Accepted")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(socket.closed).toBe(true);
    expect(pipeline.closed).toBe(true);
    expect(screen.getByRole("img", { name: "Disconnected Android screen" })).toBeInTheDocument();
  });

  it("sends volume down and task list system controls from the side rail", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: false,
            decodedFrames: 0,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "idle",
            videoSize: undefined,
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await user.click(screen.getByRole("button", { name: "Volume down" }));
    await user.click(screen.getByRole("button", { name: "Task list" }));

    const volumeDown = decodeFrame(socket.sent[1]!);
    const taskList = decodeFrame(socket.sent[2]!);
    expect(volumeDown.ok && [...volumeDown.value.payload]).toEqual([4]);
    expect(taskList.ok && [...taskList.value.payload]).toEqual([2]);
  });

  it("returns to the disconnected placeholder when the session socket closes remotely", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    const pipeline = new FakeVideoPipeline({
      configured: true,
      decodedFrames: 1,
      droppedFrames: 0,
      lastError: undefined,
      pressure: false,
      status: "ready",
      videoSize: { height: 1280, width: 720 },
    });
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() => pipeline}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    expect(await screen.findByText("Video ready")).toBeInTheDocument();

    socket.remoteClose();

    await waitFor(() => expect(pipeline.closed).toBe(true));
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.queryByText("Session s-emulator")).not.toBeInTheDocument();
    expect(screen.queryByText("Video ready")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Disconnected Android screen" })).toBeInTheDocument();
  });

  it("ignores stale close events from an older session socket", async () => {
    const user = userEvent.setup();
    const sockets = [new FakeBinaryWebSocket(), new FakeBinaryWebSocket()];
    const pipelines = [
      new FakeVideoPipeline({
        configured: true,
        decodedFrames: 1,
        droppedFrames: 0,
        lastError: undefined,
        pressure: false,
        status: "ready",
        videoSize: { height: 1280, width: 720 },
      }),
      new FakeVideoPipeline({
        configured: true,
        decodedFrames: 1,
        droppedFrames: 0,
        lastError: undefined,
        pressure: false,
        status: "ready",
        videoSize: { height: 1920, width: 860 },
      }),
    ];
    let sessionIndex = 0;
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: `s-${++sessionIndex}`,
            serial: "emulator-5554",
            token: `token-${sessionIndex}`,
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(sockets[sessionIndex - 1]!)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() => pipelines[sessionIndex - 1]!}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    sockets[0]!.open();
    await screen.findByText("Session s-1");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(pipelines[0]!.closed).toBe(true);

    await user.click(screen.getByRole("button", { name: "Start" }));
    sockets[1]!.open();
    await screen.findByText("Session s-2");
    sockets[0]!.remoteClose();

    expect(screen.getByText("Session s-2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(pipelines[1]!.closed).toBe(false);
  });

  it("ignores delayed video snapshots after a session has stopped", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    const pipeline = new DeferredVideoPipeline();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() => pipeline}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await user.click(screen.getByRole("button", { name: "Stop" }));

    pipeline.resolve({
      configured: true,
      decodedFrames: 1,
      droppedFrames: 0,
      lastError: undefined,
      pressure: false,
      status: "ready",
      videoSize: { height: 1280, width: 720 },
    });

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Disconnected Android screen" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("Video ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Session s-emulator")).not.toBeInTheDocument();
  });

  it("ignores delayed socket close events after unmount cleanup", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    const pipeline = new FakeVideoPipeline({
      configured: true,
      decodedFrames: 1,
      droppedFrames: 0,
      lastError: undefined,
      pressure: false,
      status: "ready",
      videoSize: { height: 1280, width: 720 },
    });
    const { unmount } = render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() => pipeline}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");

    unmount();

    expect(socket.closed).toBe(true);
    expect(pipeline.closed).toBe(true);
    expect(() => socket.remoteClose()).not.toThrow();
  });

  it("shows unsupported decoder state from the video pipeline", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: false,
            decodedFrames: 0,
            droppedFrames: 0,
            lastError: "WebCodecs VideoDecoder is unavailable in this browser.",
            pressure: false,
            status: "unsupported",
            videoSize: undefined,
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    socket.receive(new Uint8Array([1, 2, 3]));

    expect(await screen.findAllByText("WebCodecs unsupported")).toHaveLength(2);
    expect(
      screen.getAllByText("WebCodecs VideoDecoder is unavailable in this browser."),
    ).toHaveLength(2);
  });

  it("shows fallback unsupported browser guidance", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: false,
            decodedFrames: 0,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "unsupported",
            videoSize: undefined,
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    socket.receive(new Uint8Array([1]));

    expect(await screen.findByText("Use Chrome or Edge")).toBeInTheDocument();
  });

  it("sends pointer keyboard and text control frames from the canvas", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1280, width: 720 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    canvas.setPointerCapture = setPointerCapture;
    canvas.releasePointerCapture = releasePointerCapture;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 100,
        height: 100,
        left: 10,
        right: 110,
        toJSON: () => ({}),
        top: 20,
        width: 100,
        x: 10,
        y: 20,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, {
      buttons: 1,
      clientX: 60,
      clientY: 70,
      pointerId: 23,
      pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      buttons: 1,
      clientX: 65,
      clientY: 75,
      pointerId: 23,
      pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      buttons: 0,
      clientX: 70,
      clientY: 80,
      pointerId: 23,
    });
    fireEvent.pointerCancel(canvas, {
      buttons: 0,
      clientX: 70,
      clientY: 80,
      pointerId: 23,
    });
    fireEvent.pointerUp(canvas, {
      buttons: 0,
      clientX: 90,
      clientY: 95,
      pointerId: 23,
    });
    await waitFor(() => {
      expect(
        socket.sent
          .slice(1)
          .map(decodedType)
          .filter((type) => type === MessageType.ControlPointer),
      ).toHaveLength(2);
    });
    fireEvent.keyDown(canvas, {
      code: "Enter",
      repeat: true,
      shiftKey: true,
    });
    fireEvent.keyUp(canvas, {
      code: "Enter",
    });
    fireEvent.keyDown(canvas, {
      code: "F24",
    });
    const textInput = screen.getByLabelText("Android text input");
    fireEvent(
      textInput,
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: "A",
        inputType: "insertText",
      }),
    );
    const sentAfterText = socket.sent.length;
    fireEvent(
      textInput,
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: null,
        inputType: "deleteContentBackward",
      }),
    );
    fireEvent(
      textInput,
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: "",
        inputType: "insertText",
      }),
    );
    fireEvent.compositionEnd(textInput, { data: "語" });
    fireEvent.compositionEnd(textInput, { data: "" });

    const sentTypes = socket.sent.slice(1).map(decodedType);
    expect(socket.sent).toHaveLength(sentAfterText + 1);
    expect(sentTypes).toEqual([
      MessageType.ControlPointer,
      MessageType.ControlPointer,
      MessageType.ControlKey,
      MessageType.ControlKey,
      MessageType.ControlText,
      MessageType.ControlText,
    ]);
    expect(setPointerCapture).toHaveBeenCalledWith(23);
    expect(releasePointerCapture).toHaveBeenCalledWith(23);
  });

  it("interpolates long pointer drags into continuous move frames", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 1000 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 10, clientY: 50, pointerId: 101 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 90, clientY: 50, pointerId: 101 });

    await waitFor(() => {
      expect(socket.sent.slice(1).map(decodedType)).toHaveLength(9);
    });
    const pointerFrames = socket.sent.slice(1).map(decodePointerPayload);
    const buttonStates = socket.sent.slice(1).map(decodePointerButtons);
    const moveFrames = pointerFrames.filter((frame) => frame.action === 1);
    expect(pointerFrames.at(0)).toEqual({ action: 0, pointerId: 0, x: 100, y: 500 });
    expect(pointerFrames.at(-1)).toEqual({ action: 2, pointerId: 0, x: 900, y: 500 });
    expect(moveFrames).toHaveLength(7);
    expect(moveFrames.map((frame) => frame.x)).toEqual([210, 330, 440, 560, 670, 790, 900]);
    expect(buttonStates.at(0)).toBe(1);
    expect(buttonStates.slice(1, -1).every((buttons) => buttons === 1)).toBe(true);
    expect(buttonStates.at(-1)).toBe(0);
  });

  it("does not replay delayed drag frames into a later session", async () => {
    const user = userEvent.setup();
    const sockets = [new FakeBinaryWebSocket(), new FakeBinaryWebSocket()];
    let sessionIndex = 0;
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: `s-${++sessionIndex}`,
            serial: "emulator-5554",
            token: `token-${sessionIndex}`,
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(sockets[sessionIndex - 1]!)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 1000 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    sockets[0]!.open();
    await screen.findByText("Session s-1");
    sockets[0]!.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 10, clientY: 50, pointerId: 101 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 90, clientY: 50, pointerId: 101 });
    await user.click(screen.getByRole("button", { name: "Stop" }));

    await user.click(screen.getByRole("button", { name: "Start" }));
    sockets[1]!.open();
    await screen.findByText("Session s-2");
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    expect(sockets[1]!.sent.map(decodedType)).toEqual([MessageType.SessionHello]);
  });

  it("does not replay delayed drag frames into a later gesture with the same pointer id", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 1000 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 10, clientY: 50, pointerId: 101 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 20, clientY: 40, pointerId: 101 });
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 100, y: 500 },
      { action: 2, pointerId: 0, x: 900, y: 500 },
      { action: 0, pointerId: 0, x: 200, y: 400 },
    ]);
  });

  it("does not replay delayed drag frames into a later gesture that reuses the Android pointer slot", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 1000 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 10, clientY: 50, pointerId: 101 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 20, clientY: 40, pointerId: 202 });
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 100, y: 500 },
      { action: 1, pointerId: 0, x: 210, y: 500 },
      { action: 1, pointerId: 0, x: 330, y: 500 },
      { action: 1, pointerId: 0, x: 440, y: 500 },
      { action: 1, pointerId: 0, x: 560, y: 500 },
      { action: 1, pointerId: 0, x: 670, y: 500 },
      { action: 1, pointerId: 0, x: 790, y: 500 },
      { action: 1, pointerId: 0, x: 900, y: 500 },
      { action: 2, pointerId: 0, x: 900, y: 500 },
      { action: 0, pointerId: 0, x: 200, y: 400 },
    ]);
  });

  it("maps simultaneous browser pointers to separate Android pointer ids", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 500 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 200,
        height: 200,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 20, clientY: 40, pointerId: 101 });
    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 80, clientY: 160, pointerId: 202 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 10, clientY: 30, pointerId: 101 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 90, clientY: 170, pointerId: 202 });
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 10, clientY: 30, pointerId: 101 });
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 90, clientY: 170, pointerId: 202 });

    await waitFor(() => {
      expect(socket.sent.slice(1).map(decodePointerPayload)).toHaveLength(8);
    });
    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 100, y: 200 },
      { action: 0, pointerId: 1, x: 400, y: 800 },
      { action: 1, pointerId: 0, x: 75, y: 175 },
      { action: 1, pointerId: 1, x: 425, y: 825 },
      { action: 1, pointerId: 0, x: 50, y: 150 },
      { action: 2, pointerId: 0, x: 50, y: 150 },
      { action: 1, pointerId: 1, x: 450, y: 850 },
      { action: 2, pointerId: 1, x: 450, y: 850 },
    ]);
  });

  it("turns modified pointer drags into synthetic pinch gestures", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 500 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 200,
        height: 200,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, {
      buttons: 1,
      clientX: 50,
      clientY: 100,
      ctrlKey: true,
      pointerId: 303,
    });
    fireEvent.pointerMove(canvas, {
      buttons: 1,
      clientX: 80,
      clientY: 160,
      ctrlKey: true,
      pointerId: 303,
    });
    fireEvent.pointerUp(canvas, {
      buttons: 0,
      clientX: 80,
      clientY: 160,
      ctrlKey: true,
      pointerId: 303,
    });

    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 250, y: 340 },
      { action: 0, pointerId: 1, x: 250, y: 660 },
      { action: 1, pointerId: 0, x: 400, y: 800 },
      { action: 1, pointerId: 1, x: 100, y: 200 },
      { action: 2, pointerId: 1, x: 100, y: 200 },
      { action: 2, pointerId: 0, x: 400, y: 800 },
    ]);
    expect(socket.sent.slice(1).map(decodePointerButtons)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("sends a single cancel frame for synthetic pinch cancellation", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 500 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 200,
        height: 200,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, {
      buttons: 1,
      clientX: 50,
      clientY: 100,
      ctrlKey: true,
      pointerId: 303,
    });
    fireEvent.pointerCancel(canvas, {
      buttons: 0,
      clientX: 50,
      clientY: 100,
      ctrlKey: true,
      pointerId: 303,
    });

    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 250, y: 340 },
      { action: 0, pointerId: 1, x: 250, y: 660 },
      { action: 3, pointerId: 0, x: 250, y: 340 },
    ]);
  });

  it("clears every active pointer after a browser pointer cancel", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 500 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 200,
        height: 200,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 20, clientY: 40, pointerId: 101 });
    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 80, clientY: 160, pointerId: 202 });
    fireEvent.pointerCancel(canvas, { buttons: 0, clientX: 80, clientY: 160, pointerId: 202 });
    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 40, clientY: 80, pointerId: 303 });

    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 100, y: 200 },
      { action: 0, pointerId: 1, x: 400, y: 800 },
      { action: 3, pointerId: 1, x: 400, y: 800 },
      { action: 0, pointerId: 0, x: 200, y: 400 },
    ]);
  });

  it("drops queued frames for already released pointers after a browser pointer cancel", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 1000 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 10, clientY: 50, pointerId: 101 });
    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 50, clientY: 50, pointerId: 202 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerCancel(canvas, { buttons: 0, clientX: 50, clientY: 50, pointerId: 202 });
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 100, y: 500 },
      { action: 0, pointerId: 1, x: 500, y: 500 },
      { action: 3, pointerId: 1, x: 500, y: 500 },
    ]);
  });

  it("queues synthetic pinch start behind an unfinished same-pointer release", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 1000 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 10, clientY: 50, pointerId: 101 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerDown(canvas, {
      buttons: 1,
      clientX: 50,
      clientY: 50,
      ctrlKey: true,
      pointerId: 101,
    });
    fireEvent.pointerMove(canvas, {
      buttons: 1,
      clientX: 80,
      clientY: 50,
      ctrlKey: true,
      pointerId: 101,
    });
    fireEvent.pointerUp(canvas, {
      buttons: 0,
      clientX: 80,
      clientY: 50,
      ctrlKey: true,
      pointerId: 101,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 100, y: 500 },
      { action: 2, pointerId: 0, x: 900, y: 500 },
      { action: 0, pointerId: 0, x: 500, y: 180 },
      { action: 0, pointerId: 1, x: 500, y: 820 },
      { action: 1, pointerId: 0, x: 800, y: 500 },
      { action: 1, pointerId: 1, x: 200, y: 500 },
      { action: 2, pointerId: 1, x: 200, y: 500 },
      { action: 2, pointerId: 0, x: 800, y: 500 },
    ]);
  });

  it("queues synthetic pinch start behind an unfinished reused Android slot release", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: true,
            decodedFrames: 1,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "ready",
            videoSize: { height: 1000, width: 1000 },
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("Session s-emulator");
    socket.receive(new Uint8Array([1, 2, 3]));
    await screen.findByText("Video ready");

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = () =>
      ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      }) as DOMRect;

    fireEvent.pointerDown(canvas, { buttons: 1, clientX: 10, clientY: 50, pointerId: 101 });
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 90, clientY: 50, pointerId: 101 });
    fireEvent.pointerDown(canvas, {
      buttons: 1,
      clientX: 50,
      clientY: 50,
      ctrlKey: true,
      pointerId: 202,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    expect(socket.sent.slice(1).map(decodePointerPayload)).toEqual([
      { action: 0, pointerId: 0, x: 100, y: 500 },
      { action: 1, pointerId: 0, x: 210, y: 500 },
      { action: 1, pointerId: 0, x: 330, y: 500 },
      { action: 1, pointerId: 0, x: 440, y: 500 },
      { action: 1, pointerId: 0, x: 560, y: 500 },
      { action: 1, pointerId: 0, x: 670, y: 500 },
      { action: 1, pointerId: 0, x: 790, y: 500 },
      { action: 1, pointerId: 0, x: 900, y: 500 },
      { action: 2, pointerId: 0, x: 900, y: 500 },
      { action: 0, pointerId: 0, x: 500, y: 180 },
      { action: 0, pointerId: 1, x: 500, y: 820 },
    ]);
  });

  it("reports decode pressure without crashing the session", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    const pipeline = new FakeVideoPipeline({
      configured: false,
      decodedFrames: 0,
      droppedFrames: 1,
      lastError: undefined,
      pressure: true,
      status: "ready",
      videoSize: { height: 1280, width: 720 },
    });
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() => pipeline}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    socket.receive(new Uint8Array([1]));

    expect(await screen.findAllByText("Decode pressure")).toHaveLength(2);
    expect(screen.getByText("Decode pressure detected")).toBeInTheDocument();
  });

  it("reports decoder callback errors", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(new FakeBinaryWebSocket())}
        storage={createMemoryStorage()}
        videoPipelineFactory={(_canvas, onError) => {
          onError("Decoder failed");
          return new FakeVideoPipeline({
            configured: false,
            decodedFrames: 0,
            droppedFrames: 0,
            lastError: "Decoder failed",
            pressure: false,
            status: "error",
            videoSize: undefined,
          });
        }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Decoder failed")).toBeInTheDocument();
  });

  it("shows fallback decoder error detail", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: false,
            decodedFrames: 0,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "error",
            videoSize: undefined,
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    socket.receive(new Uint8Array([1]));

    expect(await screen.findByText("Decoder failed")).toBeInTheDocument();
  });

  it("sends Back system control from the side rail", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: false,
            decodedFrames: 0,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "idle",
            videoSize: undefined,
          })
        }
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await user.click(screen.getByRole("button", { name: "Back" }));

    const back = decodeFrame(socket.sent[1]!);
    expect(back.ok && back.value.header.type).toBe(MessageType.ControlSystem);
    expect(back.ok && [...back.value.payload]).toEqual([0]);
  });

  it("shows session creation errors for the selected device", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => {
            throw new Error("socket closed");
          },
          listDevices: async () => [
            {
              authorizationState: "authorized",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        storage={createMemoryStorage()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Android device emulator-5554" }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("socket closed")).toBeInTheDocument();
  });

  it("persists theme preference and exposes log drawer clear state", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
        }}
        initialLogs={[
          "10:42:10.231 INFO stream Starting stream",
          "10:42:11.004 WARN encoder Bitrate pressure detected",
          "Session stopped",
        ]}
        storage={storage}
      />,
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("button", { name: "Light theme" }));

    expect(storage.getItem("droid-webscr.theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "Dark theme" }));

    expect(storage.getItem("droid-webscr.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    const logDrawer = screen.getByRole("region", { name: "Log drawer" });
    expect(within(logDrawer).getByText("Starting stream")).toBeInTheDocument();
    expect(within(logDrawer).getByText("Starting stream").closest("p")).toHaveClass(
      "log-line-structured",
    );
    expect(within(logDrawer).getByText("Session stopped").closest("p")).toHaveClass(
      "log-line-plain",
    );
    await user.selectOptions(
      within(logDrawer).getByRole("combobox", { name: "Log level" }),
      "warn",
    );
    expect(within(logDrawer).getByText("Bitrate pressure detected")).toBeInTheDocument();
    expect(within(logDrawer).queryByText("Starting stream")).not.toBeInTheDocument();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    const logResizer = within(logDrawer).getByRole("separator", { name: "Resize agent log" });
    fireEvent.pointerEnter(logResizer);
    expect(logResizer).toHaveClass("hovered");
    fireEvent.pointerLeave(logResizer);
    expect(logResizer).not.toHaveClass("hovered");
    fireEvent.pointerDown(logResizer, { clientY: 584 });
    fireEvent.pointerMove(window, { clientY: 520 });
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--log-height"),
      ).toBe("200px"),
    );
    fireEvent.pointerUp(window);
    await user.click(within(logDrawer).getByRole("button", { name: "Clear logs" }));

    expect(within(logDrawer).getByText("No logs")).toBeInTheDocument();
  });

  it("matches the design interaction contract for chrome, access, and guarded actions", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const socket = new FakeBinaryWebSocket();
    const saveRuntimeBind = vi.fn(async (bindHost: string, port: number) => ({
      bindHost,
      clipboardEnabled: false,
      message: `Agent is now listening on ${bindHost}:${port}.`,
      ok: true,
      port,
      shareUrl: `http://${bindHost}:${port}`,
    }));
    const saveRuntimeClipboard = vi.fn(async (enabled: boolean) => ({
      bindHost: "127.0.0.1",
      clipboardEnabled: enabled,
      message: `Clipboard sync ${enabled ? "enabled" : "disabled"}`,
      ok: true,
      port: 7391,
    }));
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          getRuntimeConfig: async () => ({
            bindHost: "127.0.0.1",
            clipboardEnabled: false,
            port: 7391,
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
          saveRuntimeBind,
          saveRuntimeClipboard,
          shareUrl: async () => ({ url: "http://127.0.0.1:7391" }),
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={storage}
        videoPipelineFactory={() =>
          new FakeVideoPipeline({
            configured: false,
            decodedFrames: 0,
            droppedFrames: 0,
            lastError: undefined,
            pressure: false,
            status: "idle",
            videoSize: undefined,
          })
        }
      />,
    );

    expect(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Device and access controls" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("complementary", { name: "Device and access controls" })).toBeVisible();

    expect(screen.queryByRole("button", { name: "Capture" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Bind" }));
    expect(screen.getByRole("dialog", { name: "Bind access" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Bind address" })).toHaveValue("127.0.0.1");
    expect(screen.getByLabelText("Port")).toHaveValue(7391);
    expect(screen.getByLabelText("Share URL")).toHaveValue("http://127.0.0.1:7391");
    expect(screen.getByText(/Non-local bind addresses allow/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy share URL" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Apply bind" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Apply bind" }));
    expect(saveRuntimeBind).toHaveBeenCalledWith("127.0.0.1", 7391);
    expect(
      await screen.findByText("Agent is now listening on 127.0.0.1:7391."),
    ).toBeInTheDocument();
    expect(storage.getItem("droid-webscr.agentEndpoint")).toBe("http://127.0.0.1:7391");
    await user.click(screen.getByRole("button", { name: "Bind" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const clipboard = screen.getByRole("button", { name: "Toggle clipboard sync" });
    expect(clipboard).toBeEnabled();
    expect(clipboard).toHaveAttribute("aria-pressed", "false");
    await user.click(clipboard);
    expect(saveRuntimeClipboard).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Clipboard sync enabled")).toBeInTheDocument();
    expect(clipboard).toHaveAttribute("aria-pressed", "true");

    expect(screen.getByRole("button", { name: "Power" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rotate right" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("button", { name: "Power" })).toBeDisabled();
    socket.open();
    await user.click(await screen.findByRole("button", { name: "Power" }));
    expect(screen.getByRole("dialog", { name: "Power action" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send power" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("renders clipboard as the runtime setting source of truth", async () => {
    const user = userEvent.setup();
    const saveRuntimeClipboard = vi.fn(async (enabled: boolean) => ({
      bindHost: "127.0.0.1",
      clipboardEnabled: enabled,
      message: `Clipboard sync ${enabled ? "enabled" : "disabled"}`,
      ok: true,
      port: 7391,
    }));
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          getRuntimeConfig: async () => ({
            bindHost: "127.0.0.1",
            clipboardEnabled: true,
            port: 7391,
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
          saveRuntimeClipboard,
        }}
        storage={createMemoryStorage()}
      />,
    );

    const clipboard = await screen.findByRole("button", { name: "Toggle clipboard sync" });
    expect(clipboard).toHaveAttribute("aria-pressed", "true");
    expect(clipboard).toHaveAttribute("title", "Clipboard sync enabled");

    await user.click(clipboard);

    expect(saveRuntimeClipboard).toHaveBeenCalledWith(false);
    expect(await screen.findAllByText("Clipboard sync disabled")).not.toHaveLength(0);
    expect(clipboard).toHaveAttribute("aria-pressed", "false");
    expect(clipboard).toHaveAttribute("title", "Clipboard sync disabled");
    expect(screen.queryByText(/policy/i)).not.toBeInTheDocument();
  });

  it("matches the design interaction contract for device menus and adb scanning", async () => {
    const user = userEvent.setup();
    const createdSessions: string[] = [];
    const logRequests: Array<readonly [string, number | undefined]> = [];
    const socket = new FakeBinaryWebSocket();
    let scanCalls = 0;
    render(
      <DroidWebscrApp
        client={{
          createSession: async (serial) => {
            createdSessions.push(serial);
            return {
              sessionId: `s-${serial}`,
              serial,
              token: "token-emulator",
            };
          },
          getDeviceLogs: async (serial, lines) => {
            logRequests.push([serial, lines]);
            return {
              lines: ["06-09 13:40:01.000 I ActivityTaskManager: Displayed app"],
              ok: true,
              serial,
            };
          },
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
            {
              authorizationState: "authorized",
              model: "Pixel 6",
              serial: "R5CW70ABC12",
              transportKind: "usb",
            },
          ],
          scanDevices: async () => {
            scanCalls += 1;
            return [
              {
                authorizationState: "authorized",
                model: "Pixel 8",
                serial: "emulator-5554",
                transportKind: "emulator",
              },
              {
                authorizationState: "authorized",
                model: "Pixel 6",
                serial: "R5CW70ABC12",
                transportKind: "usb",
              },
            ];
          },
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(screen.getByRole("button", { name: "Open Pixel 6 menu" }));
    let menu = screen.getByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Show device log" }));
    expect(logRequests).toEqual([["R5CW70ABC12", 200]]);
    await waitFor(() =>
      expect(
        screen.getAllByText(
          (_, element) => element?.textContent?.includes("Displayed app") ?? false,
        ),
      ).not.toHaveLength(0),
    );

    await user.click(screen.getByRole("button", { name: "Open Pixel 6 menu" }));
    menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Rename device" })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "Start session" }));
    expect(createdSessions).toEqual(["R5CW70ABC12"]);
    socket.open();
    expect(await screen.findByText("Session s-R5CW70ABC12")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Scan adb devices" }));
    expect(scanCalls).toBe(1);
    expect(screen.getByRole("dialog", { name: "Scan adb devices" })).toBeInTheDocument();
    expect(screen.getByText(/Detected devices from adb devices -l/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect selected" })).toBeEnabled();
  });

  it("starts sessions from the selected device card menu", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession: async (serial) => ({
            sessionId: `s-${serial}`,
            serial,
            token: "token-emulator",
          }),
          getDeviceLogs: async (serial) => ({
            lines: [`${serial} log line`],
            ok: true,
            serial,
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
          scanDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(screen.getByRole("button", { name: "Open Pixel 8 menu" }));
    const menu = screen.getByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Start session" }));
    socket.open();

    expect(await screen.findByText("Session s-emulator-5554")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Pixel 8 menu" }));
    expect(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Start session" }),
    ).toBeDisabled();
  });

  it("closes the selected device menu when clicking outside the popup", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async (serial) => ({
            sessionId: `s-${serial}`,
            serial,
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        storage={createMemoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(screen.getByRole("button", { name: "Open Pixel 8 menu" }));
    const menu = screen.getByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Show device log" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Pixel 8 menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Android screen viewport"));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("uses browser localStorage when no storage override is provided", async () => {
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
        }}
      />,
    );

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    expect(window.localStorage.getItem("droid-webscr.theme")).toBe("dark");
  });
});

function decodedType(frame: Uint8Array): number | undefined {
  const decoded = decodeFrame(frame);
  return decoded.ok ? decoded.value.header.type : undefined;
}

function decodePointerPayload(frame: Uint8Array): {
  readonly action: number;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
} {
  const decoded = decodeFrame(frame);
  if (!decoded.ok || decoded.value.header.type !== MessageType.ControlPointer) {
    throw new Error("Expected a pointer control frame.");
  }
  const view = new DataView(
    decoded.value.payload.buffer,
    decoded.value.payload.byteOffset,
    decoded.value.payload.byteLength,
  );
  return {
    action: view.getUint8(0),
    pointerId: view.getUint16(2, false),
    x: view.getUint32(4, false),
    y: view.getUint32(8, false),
  };
}

function decodePointerButtons(frame: Uint8Array): number {
  const decoded = decodeFrame(frame);
  if (!decoded.ok || decoded.value.header.type !== MessageType.ControlPointer) {
    throw new Error("Expected a pointer control frame.");
  }
  const view = new DataView(
    decoded.value.payload.buffer,
    decoded.value.payload.byteOffset,
    decoded.value.payload.byteLength,
  );
  return view.getUint16(14, false);
}

function jsonResponse(body: unknown): Response {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    ok: true,
    status: 200,
  } as Response;
}

class FakeVideoPipeline implements VideoPipeline {
  public readonly accepted: Uint8Array[] = [];
  public closed = false;
  public resetCount = 0;

  public constructor(private readonly nextSnapshot: VideoPipelineSnapshot) {}

  public async acceptFrame(frame: Uint8Array): Promise<VideoPipelineSnapshot> {
    this.accepted.push(frame);
    return this.nextSnapshot;
  }

  public close(): void {
    this.closed = true;
  }

  public reset(): void {
    this.resetCount += 1;
  }

  public snapshot(): VideoPipelineSnapshot {
    return this.nextSnapshot;
  }
}

class DeferredVideoPipeline implements VideoPipeline {
  public closed = false;
  private resolveFrame: ((snapshot: VideoPipelineSnapshot) => void) | undefined;

  public acceptFrame(): Promise<VideoPipelineSnapshot> {
    return new Promise((resolve) => {
      this.resolveFrame = resolve;
    });
  }

  public close(): void {
    this.closed = true;
  }

  public reset(): void {
    return;
  }

  public resolve(snapshot: VideoPipelineSnapshot): void {
    this.resolveFrame?.(snapshot);
  }

  public snapshot(): VideoPipelineSnapshot {
    return {
      configured: false,
      decodedFrames: 0,
      droppedFrames: 0,
      lastError: undefined,
      pressure: false,
      status: "idle",
      videoSize: undefined,
    };
  }
}
