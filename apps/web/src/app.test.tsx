import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import webPackageJson from "../package.json" with { type: "json" };

describe("DroidWebscrApp", () => {
  it("shows the web package version in the brand", async () => {
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          getRuntimeConfig: async () => {
            throw new Error("runtime config unavailable");
          },
          listDevices: async () => [],
        }}
        storage={createMemoryStorage()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "droid-webscr" })).toBeInTheDocument();
    expect(screen.getByText(`v${webPackageJson.version}`)).toBeInTheDocument();
  });

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

  it("observes viewport size with ResizeObserver when the browser provides it", async () => {
    const observed: Element[] = [];
    const disconnected: boolean[] = [];
    class TestResizeObserver {
      public constructor(private readonly callback: ResizeObserverCallback) {}

      public disconnect(): void {
        disconnected.push(true);
      }

      public observe(element: Element): void {
        observed.push(element);
        this.callback([], this);
      }

      public unobserve(): void {
        return;
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const { unmount } = render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
        }}
        storage={createMemoryStorage()}
      />,
    );

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    expect(observed.length).toBeGreaterThan(0);
    unmount();
    expect(disconnected.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
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
    expect(createAgentEndpointUrl("0.0.0.0", 7400, "not a url")).toBe("http://192.168.1.20:7400");
    expect(createAgentEndpointUrl("::", 7400)).toBe("http://192.168.1.20:7400");
    expect(createAgentEndpointUrl("127.0.0.1", 7400)).toBe("http://127.0.0.1:7400");
    expect(createAgentEndpointUrl("127.0.0.1", Number.NaN)).toBe("http://127.0.0.1:7391");

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
    expect(screen.queryByRole("button", { name: "Bind" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Toggle clipboard sync" })).not.toBeInTheDocument();
  });

  it("uses injected agent endpoint and auth token before persisted storage", async () => {
    const storage = createMemoryStorage({
      "droid-webscr.agentEndpoint": "http://127.0.0.1:7391",
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

    render(
      <DroidWebscrApp
        initialAgentConfig={{
          agentUrl: "http://127.0.0.1:7400",
          authToken: "injected-token",
        }}
        storage={storage}
      />,
    );

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:7400/api/config", {
        headers: { authorization: "Bearer injected-token" },
      }),
    );
  });

  it("uses design fallback devices only for file-based design previews", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        hostname: "",
        port: "",
        protocol: "file:",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        headers: new Headers({ "content-type": "text/html" }),
        ok: true,
        status: 200,
      })),
    );

    render(<DroidWebscrApp storage={createMemoryStorage()} />);

    expect(
      await screen.findByRole("button", { name: /Pixel 8 Pro 192.168.1.42:5555/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pixel 6a 192.168.1.45:5555/ })).toBeInTheDocument();

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
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
    expect(screen.getByRole("button", { name: "Refresh devices" })).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Toggle clipboard sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bind" })).not.toBeInTheDocument();
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

  it("ignores duplicate start requests while a session is starting", async () => {
    const user = userEvent.setup();
    let resolveSession:
      | ((session: {
          readonly serial: string;
          readonly sessionId: string;
          readonly token: string;
        }) => void)
      | undefined;
    const createSession = vi.fn(
      async () =>
        await new Promise<{
          readonly serial: string;
          readonly sessionId: string;
          readonly token: string;
        }>((resolve) => {
          resolveSession = resolve;
        }),
    );
    const socket = new FakeBinaryWebSocket();
    render(
      <DroidWebscrApp
        client={{
          createSession,
          listDevices: async () => [{ authorizationState: "authorized", serial: "emulator-5554" }],
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Android device emulator-5554" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    resolveSession?.({ serial: "emulator-5554", sessionId: "s-emulator", token: "token-emulator" });
    socket.open();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Session s-emulator")).toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "Refresh devices" }));

    expect(await screen.findAllByText("adb unavailable")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Refresh devices" })).not.toBeInTheDocument();
  });

  it("refreshes the device list directly and confirms the action with a toast", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
          scanDevices: async () => {
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

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh devices" }));

    expect(
      await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Devices refreshed")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

  it("locks sidebar controls to the active device while a session is connected", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    let scanCalls = 0;
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
            {
              authorizationState: "authorized",
              model: "Pixel 6",
              serial: "R5CW70ABC12",
              transportKind: "usb",
            },
          ],
          scanDevices: async () => {
            scanCalls += 1;
            return [];
          },
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
      />,
    );

    const pixel8 = await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(pixel8);
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
    expect(pixel8).toHaveTextContent("session active");
    expect(screen.getByRole("button", { name: /Pixel 6 R5CW70ABC12/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Pixel 6 menu" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh devices" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect by endpoint" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Bind" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh devices" }));
    expect(scanCalls).toBe(0);

    await user.click(stopButton);

    const startButton = screen.getByRole("button", { name: "Start" });
    expect(startButton).toBeEnabled();
    expect(startButton).toHaveClass("session-toggle");
    expect(startButton).not.toHaveClass("session-running");
    expect(screen.getByRole("combobox", { name: "FPS" })).toBeEnabled();
    expect(screen.queryByText("Session s-emulator")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Disconnected Android screen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pixel 6 R5CW70ABC12/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open Pixel 6 menu" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Refresh devices" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect by endpoint" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Bind" })).not.toBeInTheDocument();
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
    const resetDeviceRotation = vi.fn(async () => ({
      message: "Device emulator-5554 rotation reset",
      ok: true,
    }));
    const rotateDevice = vi.fn(async () => ({
      message: "Device emulator-5554 rotated right",
      ok: true,
    }));
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
          resetDeviceRotation,
          rotateDevice,
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
    expect(rotateDevice).toHaveBeenCalledWith("emulator-5554", "right");
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

    expect(screen.queryByText("control:home:Accepted")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(resetDeviceRotation).toHaveBeenCalledWith("emulator-5554");
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
    socket.receive(new Uint8Array([1]));
    expect(await screen.findByText("Waiting for Android video configuration")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Volume down" }));
    await user.click(screen.getByRole("button", { name: "Task list" }));

    const volumeDown = decodeFrame(socket.sent[1]!);
    const taskList = decodeFrame(socket.sent[2]!);
    expect(volumeDown.ok && [...volumeDown.value.payload]).toEqual([4]);
    expect(taskList.ok && [...taskList.value.payload]).toEqual([2]);
  });

  it("reports device rotation failures while a session is connected", async () => {
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
          rotateDevice: async () => {
            throw new Error("rotation shell failed");
          },
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
    await user.click(await screen.findByRole("button", { name: "Rotate right" }));

    expect(await screen.findByText("rotation shell failed")).toBeInTheDocument();
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
    fireEvent.pointerUp(canvas, { buttons: 0, clientX: 95, clientY: 50, pointerId: 101 });

    await waitFor(() => {
      expect(socket.sent.slice(1).map(decodedType)).toHaveLength(10);
    });
    const pointerFrames = socket.sent.slice(1).map(decodePointerPayload);
    const buttonStates = socket.sent.slice(1).map(decodePointerButtons);
    const moveFrames = pointerFrames.filter((frame) => frame.action === 1);
    expect(pointerFrames.at(0)).toEqual({ action: 0, pointerId: 0, x: 100, y: 500 });
    expect(pointerFrames.at(-1)).toEqual({ action: 2, pointerId: 0, x: 950, y: 500 });
    expect(moveFrames).toHaveLength(8);
    expect(moveFrames.map((frame) => frame.x)).toEqual([210, 330, 440, 560, 670, 790, 900, 950]);
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

  it("drops browser pointers when all Android pointer slots are occupied", async () => {
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

    for (let pointerId = 1; pointerId <= 11; pointerId += 1) {
      fireEvent.pointerDown(canvas, { buttons: 1, clientX: 50, clientY: 50, pointerId });
    }

    expect(socket.sent.slice(1).map(decodedType)).toHaveLength(10);
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
    expect(screen.queryByText("Decode pressure detected")).not.toBeInTheDocument();
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
    expect(document.querySelector(".topbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh devices" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Android hardware controls" })).toHaveClass(
      "control-rail",
    );
    expect(screen.getByRole("region", { name: "Device log drawer" })).toHaveClass("log-drawer");

    await user.click(screen.getByRole("button", { name: "Dark theme" }));

    expect(storage.getItem("droid-webscr.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    const logDrawer = screen.getByRole("region", { name: "Device log drawer" });
    expect(within(logDrawer).getByRole("heading", { name: "DEVICE LOG" })).toBeInTheDocument();
    expect(within(logDrawer).getByRole("button", { name: "Expand device log" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--log-height"),
    ).toBe("34px");
    expect(within(logDrawer).queryByRole("separator", { name: "Resize device log" })).toBeNull();
    expect(within(logDrawer).queryByText("Select a device to view logs")).toBeNull();
    await user.click(within(logDrawer).getByRole("button", { name: "Expand device log" }));
    expect(within(logDrawer).getByRole("button", { name: "Collapse device log" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(logDrawer).getByText("Select a device to view logs")).toBeInTheDocument();
    expect(within(logDrawer).queryByText("Starting stream")).not.toBeInTheDocument();
    expect(within(logDrawer).queryByText("Session stopped")).not.toBeInTheDocument();
    await user.selectOptions(
      within(logDrawer).getByRole("combobox", { name: "Log level" }),
      "warn",
    );
    expect(within(logDrawer).queryByText("Bitrate pressure detected")).not.toBeInTheDocument();
    expect(within(logDrawer).queryByText("Starting stream")).not.toBeInTheDocument();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    expect(
      document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--log-height"),
    ).toBe("180px");
    const logResizer = within(logDrawer).getByRole("separator", { name: "Resize device log" });
    fireEvent.pointerEnter(logResizer);
    expect(logResizer).toHaveClass("hovered");
    fireEvent.pointerLeave(logResizer);
    expect(logResizer).not.toHaveClass("hovered");
    fireEvent.mouseEnter(logResizer);
    expect(logResizer).toHaveClass("hovered");
    fireEvent.mouseLeave(logResizer);
    expect(logResizer).not.toHaveClass("hovered");
    fireEvent.pointerDown(logResizer, { clientY: 584 });
    fireEvent.pointerMove(window, { clientY: 520 });
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--log-height"),
      ).toBe("200px"),
    );
    fireEvent.pointerMove(window, { clientY: 20 });
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--log-height"),
      ).toBe("500px"),
    );
    fireEvent.pointerUp(window);
    fireEvent.mouseDown(logResizer, { clientY: 640 });
    fireEvent.mouseMove(window, { clientY: 632 });
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--log-height"),
      ).toBe("88px"),
    );
    fireEvent.mouseUp(window);
    await user.click(within(logDrawer).getByRole("button", { name: "Collapse device log" }));
    expect(within(logDrawer).getByRole("button", { name: "Expand device log" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--log-height"),
    ).toBe("34px");
    expect(within(logDrawer).queryByRole("separator", { name: "Resize device log" })).toBeNull();
    expect(within(logDrawer).queryByText("Select a device to view logs")).toBeNull();
    await user.click(within(logDrawer).getByRole("button", { name: "Expand device log" }));
    expect(within(logDrawer).getByRole("button", { name: "Collapse device log" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--log-height"),
    ).toBe("88px");
    expect(within(logDrawer).getByText("Select a device to view logs")).toBeInTheDocument();
    await user.click(within(logDrawer).getByRole("button", { name: "Clear logs" }));

    expect(within(logDrawer).getByText("Select a device to view logs")).toBeInTheDocument();
  });

  it("shows only selected device tail logs and supports wrapping", async () => {
    const user = userEvent.setup();
    const socket = new FakeBinaryWebSocket();
    const getDeviceLogs = vi.fn();
    const tailSessions: Array<{
      readonly onLine: (line: string) => void;
      readonly serial: string;
      readonly signal: AbortSignal;
    }> = [];
    render(
      <DroidWebscrApp
        client={{
          createSession: async (serial) => ({ serial, sessionId: `s-${serial}`, token: "t1" }),
          getDeviceLogs,
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
          tailDeviceLogs: async (serial, options) => {
            tailSessions.push({ onLine: options.onLine, serial, signal: options.signal });
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
      />,
    );

    const logDrawer = await screen.findByRole("region", { name: "Device log drawer" });
    expect(within(logDrawer).getByRole("heading", { name: "DEVICE LOG" })).toBeInTheDocument();
    expect(within(logDrawer).getByRole("button", { name: "Expand device log" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(logDrawer).queryByRole("button", { name: "Start log" })).toBeNull();
    expect(tailSessions).toHaveLength(0);
    expect(getDeviceLogs).not.toHaveBeenCalled();
    await user.click(within(logDrawer).getByRole("button", { name: "Expand device log" }));
    expect(
      within(logDrawer).getByText("Start log collection to view device logs"),
    ).toBeInTheDocument();
    expect(within(logDrawer).getByRole("button", { name: "Start log" })).toBeEnabled();
    await user.click(within(logDrawer).getByRole("button", { name: "Start log" }));
    await waitFor(() => expect(tailSessions).toHaveLength(1));
    expect(tailSessions[0]?.serial).toBe("emulator-5554");
    expect(getDeviceLogs).not.toHaveBeenCalled();
    expect(within(logDrawer).getByText("Waiting for device logs")).toBeInTheDocument();
    await user.click(within(logDrawer).getByRole("button", { name: "Collapse device log" }));
    expect(tailSessions[0]?.signal.aborted).toBe(false);
    await user.click(within(logDrawer).getByRole("button", { name: "Expand device log" }));
    expect(within(logDrawer).getByRole("button", { name: "Stop log" })).toBeEnabled();

    act(() => {
      tailSessions[0]?.onLine("06-09 13:40:00.000  1000  1000 V VerboseTag: verbose line");
      tailSessions[0]?.onLine("06-09 13:40:00.100  1000  1000 D DebugTag: debug line");
      tailSessions[0]?.onLine("06-09 13:40:01.000  1000  1000 I ActivityTaskManager: Tail line 1");
      tailSessions[0]?.onLine("06-09 13:40:01.100  1000  1000 W WarnTag: warn line");
      tailSessions[0]?.onLine("06-09 13:40:01.200  1000  1000 E ErrorTag: error line");
      tailSessions[0]?.onLine("06-09 13:40:01.300  1000  1000 F FatalTag: fatal line");
      tailSessions[0]?.onLine("10:42:10.231 DEBUG app app style debug line");
      tailSessions[0]?.onLine("10:42:10.232 ERROR app app style error line");
      tailSessions[0]?.onLine("10:42:10.233 WARN app app style warn line");
      tailSessions[0]?.onLine("10:42:10.234 INFO app app style info line");
      tailSessions[0]?.onLine("10:42:10.235 INFO ");
      tailSessions[0]?.onLine("plain unstructured line");
    });
    expect(within(logDrawer).queryByText(/Tail line 1/)).not.toBeInTheDocument();
    expect(await within(logDrawer).findByText(/Tail line 1/)).toBeInTheDocument();
    const logLevelSelect = within(logDrawer).getByRole("combobox", { name: "Log level" });
    expect(logLevelSelect).toHaveValue("info");
    expect(within(logDrawer).queryByText(/verbose line/)).not.toBeInTheDocument();
    expect(within(logDrawer).queryByText("debug line")).not.toBeInTheDocument();
    expect(within(logDrawer).getByText(/^warn line$/)).toBeInTheDocument();
    expect(within(logDrawer).getByText(/^error line$/)).toBeInTheDocument();
    await user.selectOptions(logLevelSelect, "all");
    expect(within(logDrawer).getByText(/verbose line/).parentElement).toHaveClass(
      "log-line-level-verbose",
    );
    expect(within(logDrawer).getByText("debug line").parentElement).toHaveClass(
      "log-line-level-debug",
    );
    expect(within(logDrawer).getByText(/Tail line 1/).parentElement).toHaveClass(
      "log-line-level-info",
    );
    expect(within(logDrawer).getByText("06-09 13:40:01.000")).toHaveClass("log-line-time");
    expect(within(logDrawer).getByText("ActivityTaskManager")).toHaveClass("log-line-area");
    expect(within(logDrawer).getByText("Tail line 1")).toHaveClass("log-line-message");
    expect(within(logDrawer).getByText(/^warn line$/).parentElement).toHaveClass(
      "log-line-level-warn",
    );
    expect(within(logDrawer).getByText(/^error line$/).parentElement).toHaveClass(
      "log-line-level-error",
    );
    expect(within(logDrawer).getByText(/fatal line/).parentElement).toHaveClass(
      "log-line-level-error",
    );
    expect(within(logDrawer).getByText(/app style debug line/).parentElement).toHaveClass(
      "log-line-level-debug",
    );
    expect(within(logDrawer).getByText(/app style error line/).parentElement).toHaveClass(
      "log-line-level-error",
    );
    expect(within(logDrawer).getByText(/app style warn line/).parentElement).toHaveClass(
      "log-line-level-warn",
    );
    expect(within(logDrawer).getByText(/app style info line/).parentElement).toHaveClass(
      "log-line-level-info",
    );

    const wrapToggle = within(logDrawer).getByRole("checkbox", { name: "Wrap lines" });
    expect(document.querySelector(".log-lines")).not.toHaveClass("wrap-lines");
    await user.click(wrapToggle);
    expect(document.querySelector(".log-lines")).toHaveClass("wrap-lines");
    expect(within(logDrawer).queryByRole("option", { name: "Verbose" })).not.toBeInTheDocument();
    expect(within(logDrawer).getByRole("option", { name: "Debug" })).toBeInTheDocument();
    await user.selectOptions(logLevelSelect, "debug");
    expect(within(logDrawer).queryByText(/verbose line/)).not.toBeInTheDocument();
    expect(within(logDrawer).getByText("debug line")).toBeInTheDocument();
    expect(within(logDrawer).getByText(/app style debug line/)).toBeInTheDocument();
    expect(within(logDrawer).getByText(/Tail line 1/)).toBeInTheDocument();
    expect(within(logDrawer).getByText(/^warn line$/)).toBeInTheDocument();
    expect(within(logDrawer).getByText(/^error line$/)).toBeInTheDocument();
    expect(within(logDrawer).getByText(/fatal line/)).toBeInTheDocument();
    expect(within(logDrawer).queryByText(/plain unstructured line/)).not.toBeInTheDocument();
    await user.selectOptions(logLevelSelect, "info");
    expect(within(logDrawer).queryByText("debug line")).not.toBeInTheDocument();
    expect(within(logDrawer).queryByText(/verbose line/)).not.toBeInTheDocument();
    expect(within(logDrawer).getByText(/Tail line 1/)).toBeInTheDocument();
    expect(within(logDrawer).getByText(/^warn line$/)).toBeInTheDocument();
    expect(within(logDrawer).getByText(/^error line$/)).toBeInTheDocument();
    await user.selectOptions(logLevelSelect, "error");
    expect(within(logDrawer).getByText(/^error line$/)).toBeInTheDocument();
    expect(within(logDrawer).getByText(/fatal line/)).toBeInTheDocument();
    expect(within(logDrawer).queryByText(/^warn line$/)).not.toBeInTheDocument();
    await user.selectOptions(logLevelSelect, "all");

    const logLines = document.querySelector<HTMLElement>(".log-lines");
    expect(logLines).not.toBeNull();
    setLogScrollMetrics(logLines, { clientHeight: 100, scrollHeight: 1000 });
    act(() =>
      tailSessions[0]?.onLine(
        "06-09 13:40:01.400  1000  1000 I ActivityTaskManager: autoscroll anchor",
      ),
    );
    await waitFor(() => expect(logLines?.scrollTop).toBe(1000));
    fireEvent.scroll(logLines!);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });
    logLines!.scrollTop = 650;
    fireEvent.scroll(logLines!);
    act(() =>
      tailSessions[0]?.onLine("06-09 13:40:01.500  1000  1000 I ActivityTaskManager: paused line"),
    );
    expect(await within(logDrawer).findByText("paused line")).toBeInTheDocument();
    expect(logLines?.scrollTop).toBe(650);
    setLogScrollMetrics(logLines, { clientHeight: 100, scrollHeight: 1200 });
    logLines!.scrollTop = 1100;
    fireEvent.scroll(logLines!);
    setLogScrollMetrics(logLines, { clientHeight: 100, scrollHeight: 1300 });
    act(() =>
      tailSessions[0]?.onLine("06-09 13:40:01.600  1000  1000 I ActivityTaskManager: resumed line"),
    );
    expect(await within(logDrawer).findByText("resumed line")).toBeInTheDocument();
    await waitFor(() => expect(logLines?.scrollTop).toBe(1300));
    const autoscrollToggle = within(logDrawer).getByRole("checkbox", { name: "Autoscroll" });
    await user.click(autoscrollToggle);
    fireEvent.scroll(logLines!);
    act(() =>
      tailSessions[0]?.onLine("06-09 13:40:01.700  1000  1000 I ActivityTaskManager: manual line"),
    );
    expect(await within(logDrawer).findByText("manual line")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start" }));
    socket.open();
    await screen.findByText("session active");
    act(() => {
      socket.receive(
        encodeFrame({
          header: createFrameHeader({
            payloadLength: new TextEncoder().encode("internal app log").byteLength,
            streamId: StreamId.Log,
            type: MessageType.LogRecord,
          }),
          payload: new TextEncoder().encode("internal app log"),
        }),
      );
    });
    expect(within(logDrawer).queryByText("internal app log")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: /Pixel 6 R5CW70ABC12/ }));
    await waitFor(() => expect(tailSessions).toHaveLength(2));
    expect(tailSessions[0]?.signal.aborted).toBe(true);
    expect(tailSessions[1]?.serial).toBe("R5CW70ABC12");
    expect(within(logDrawer).queryByText(/Tail line 1/)).not.toBeInTheDocument();

    await user.click(within(logDrawer).getByRole("button", { name: "Clear logs" }));
    act(() =>
      tailSessions[1]?.onLine("06-09 13:40:02.000  1000  1000 I ActivityTaskManager: Tail line 2"),
    );
    expect(await within(logDrawer).findByText(/Tail line 2/)).toBeInTheDocument();
    await user.click(within(logDrawer).getByRole("button", { name: "Stop log" }));
    expect(tailSessions[1]?.signal.aborted).toBe(true);
    expect(within(logDrawer).getByRole("button", { name: "Start log" })).toBeEnabled();
    expect(within(logDrawer).getByText(/Tail line 2/)).toBeInTheDocument();
  });

  it("matches the design interaction contract for chrome and guarded actions", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const socket = new FakeBinaryWebSocket();
    const saveRuntimeClipboard = vi.fn();
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
    expect(screen.queryByRole("complementary", { name: "Device controls" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("complementary", { name: "Device controls" })).toBeVisible();

    expect(screen.queryByRole("button", { name: "Capture" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bind" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Bind access" })).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Toggle clipboard sync" })).not.toBeInTheDocument();
    expect(screen.queryByText("Clipboard")).not.toBeInTheDocument();
    expect(saveRuntimeClipboard).not.toHaveBeenCalled();

    expect(screen.getByRole("button", { name: "Power" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rotate right" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Rotate right" }));
    expect(
      document
        .querySelector<HTMLElement>(".phone-shell")
        ?.style.getPropertyValue("--phone-screen-aspect"),
    ).toBe("20 / 9");
    await user.click(screen.getByRole("button", { name: "Rotate right" }));
    expect(document.querySelector<HTMLElement>(".phone-shell")).toHaveClass("rotation-180");
    await user.click(screen.getByRole("button", { name: "Rotate left" }));
    expect(
      document
        .querySelector<HTMLElement>(".phone-shell")
        ?.style.getPropertyValue("--phone-screen-aspect"),
    ).toBe("20 / 9");
    await user.click(screen.getByRole("button", { name: "Rotate left" }));
    expect(
      document
        .querySelector<HTMLElement>(".phone-shell")
        ?.style.getPropertyValue("--phone-screen-aspect"),
    ).toBe("9 / 20");
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("button", { name: "Power" })).toBeDisabled();
    socket.open();
    await user.click(await screen.findByRole("button", { name: "Power" }));
    expect(screen.getByRole("dialog", { name: "Power action" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send power" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send power" }));
    const power = decodeFrame(socket.sent[1]!);
    expect(power.ok && power.value.header.type).toBe(MessageType.ControlSystem);
    expect(power.ok && [...power.value.payload]).toEqual([5]);
  });

  it("connects to a typed ADB endpoint from the access dialog", async () => {
    const user = userEvent.setup();
    const connectEndpoint = vi.fn();
    const scanDevices = vi.fn(async () => [
      {
        authorizationState: "authorized" as const,
        model: "Pixel 8",
        serial: "192.168.1.40:5555",
        transportKind: "network" as const,
      },
    ]);
    render(
      <DroidWebscrApp
        client={{
          connectEndpoint,
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "192.168.1.40:5555",
            token: "token-emulator",
          }),
          listDevices: async () => [],
          scanDevices,
        }}
        storage={createMemoryStorage()}
      />,
    );

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect by endpoint" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(connectEndpoint).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText("192.168.1.40:5555"), "192.168.1.40:5555");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(connectEndpoint).toHaveBeenCalledWith("192.168.1.40:5555");
    expect(scanDevices).toHaveBeenCalled();
    expect(await screen.findByText("Endpoint connected")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /Pixel 8 192.168.1.40:5555/ }),
    ).toBeInTheDocument();
  });

  it("shows dialog operation errors without closing the dialog", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          connectEndpoint: async () => {
            throw new Error("adb connect failed");
          },
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "192.168.1.40:5555",
            token: "token-emulator",
          }),
          listDevices: async () => [],
        }}
        storage={createMemoryStorage()}
      />,
    );

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect by endpoint" }));
    await user.type(screen.getByPlaceholderText("192.168.1.40:5555"), "192.168.1.40:5555");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Connect by endpoint" })).toBeInTheDocument(),
    );
  });

  it("reports unavailable device log tail support", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [{ authorizationState: "authorized", serial: "emulator-5554" }],
        }}
        storage={createMemoryStorage()}
      />,
    );

    const logDrawer = await screen.findByRole("region", { name: "Device log drawer" });
    await user.click(within(logDrawer).getByRole("button", { name: "Expand device log" }));
    await user.click(within(logDrawer).getByRole("button", { name: "Start log" }));

    expect(await screen.findByText("Device log tail is unavailable")).toBeInTheDocument();
    expect(within(logDrawer).getByText("Device log tail unavailable")).toBeInTheDocument();
  });

  it("hides clipboard controls while preserving runtime config compatibility", async () => {
    const saveRuntimeClipboard = vi.fn();
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

    await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    expect(screen.queryByRole("button", { name: "Toggle clipboard sync" })).not.toBeInTheDocument();
    expect(screen.queryByText("Clipboard")).not.toBeInTheDocument();
    expect(screen.queryByText(/policy/i)).not.toBeInTheDocument();
    expect(saveRuntimeClipboard).not.toHaveBeenCalled();
  });

  it("matches the design interaction contract for device menus and adb scanning", async () => {
    const user = userEvent.setup();
    const createdSessions: string[] = [];
    const disconnectedSerials: string[] = [];
    const getDeviceLogs = vi.fn();
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
          disconnectDevice: async (serial) => {
            disconnectedSerials.push(serial);
            return { message: `Disconnected ${serial}`, ok: true };
          },
          getDeviceLogs,
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
          tailDeviceLogs: async (_serial, options) => {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        }}
        sessionSocketFactory={() => new SessionSocket(socket)}
        storage={createMemoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(screen.getByRole("button", { name: "Open Pixel 6 menu" }));
    let menu = screen.getByRole("menu");
    expect(
      within(menu).queryByRole("menuitem", { name: "Show device log" }),
    ).not.toBeInTheDocument();
    expect(getDeviceLogs).not.toHaveBeenCalled();
    expect(within(menu).queryByRole("menuitem", { name: "Rename device" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Pixel 6 menu" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Pixel 6 menu" }));
    menu = screen.getByRole("menu");

    await user.click(within(menu).getByRole("menuitem", { name: "Start session" }));
    expect(createdSessions).toEqual(["R5CW70ABC12"]);
    socket.open();
    expect(await screen.findByText("Session s-R5CW70ABC12")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Open Pixel 6 menu" }));
    menu = screen.getByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Disconnect" }));
    expect(disconnectedSerials).toEqual(["R5CW70ABC12"]);
    await user.click(screen.getByRole("button", { name: "Refresh devices" }));
    expect(scanCalls).toBe(2);
    expect(await screen.findByText("Devices refreshed")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

    const menuButton = screen.getByRole("button", { name: "Open Pixel 8 menu" });
    expect(menuButton).toBeDisabled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
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
    await user.click(within(menu).getByRole("menuitem", { name: "Start session" }));
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

function setLogScrollMetrics(
  element: HTMLElement | null,
  metrics: { readonly clientHeight: number; readonly scrollHeight: number },
): void {
  if (!element) {
    throw new Error("Expected log lines element.");
  }
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
  });
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
