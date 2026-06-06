import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  createFrameHeader,
  decodeFrame,
  encodeFrame,
  MessageType,
  StreamId,
} from "@droid-webscr/protocol";
import { DroidWebscrApp } from "./app.js";
import { createMemoryStorage } from "./lib/memory-storage.js";
import { VideoPipeline, VideoPipelineSnapshot } from "./decoder/video-pipeline.js";
import { FakeBinaryWebSocket, SessionSocket } from "./transport/session-socket.js";

describe("DroidWebscrApp", () => {
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
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle clipboard sync" })).toBeEnabled();
    expect(screen.getByText("Bind 127.0.0.1")).toBeInTheDocument();
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
        storage={createMemoryStorage()}
      />,
    );

    const device = await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(device);
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Session s-emulator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.queryByText("Session s-emulator")).not.toBeInTheDocument();
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

    const canvas = screen.getByLabelText("Android video canvas") as HTMLCanvasElement;
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
      pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      buttons: 1,
      clientX: 70,
      clientY: 80,
      pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      buttons: 0,
      clientX: 80,
      clientY: 90,
    });
    fireEvent.pointerCancel(canvas, {
      buttons: 0,
      clientX: 80,
      clientY: 90,
    });
    fireEvent.pointerUp(canvas, {
      buttons: 0,
      clientX: 90,
      clientY: 95,
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
      MessageType.ControlPointer,
      MessageType.ControlPointer,
      MessageType.ControlKey,
      MessageType.ControlKey,
      MessageType.ControlText,
      MessageType.ControlText,
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
        initialLogs={["Agent ready", "No device selected"]}
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
    expect(within(logDrawer).getByText("Agent ready")).toBeInTheDocument();
    await user.click(within(logDrawer).getByRole("button", { name: "Clear logs" }));

    expect(within(logDrawer).getByText("No logs")).toBeInTheDocument();
  });

  it("matches the design interaction contract for chrome, access, and guarded actions", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const saveRuntimeBind = vi.fn(async (bindHost: string, port: number) => ({
      bindHost,
      clipboardEnabled: false,
      message: "Runtime bind updated; restart the agent to move the listening socket.",
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
        storage={storage}
      />,
    );

    expect(await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Device and access controls" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("complementary", { name: "Device and access controls" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("dialog", { name: "Session actions" })).toBeInTheDocument();
    expect(screen.getByLabelText("Reconnect policy")).toHaveValue("auto");
    await user.click(screen.getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: "Bind" }));
    expect(screen.getByRole("dialog", { name: "Bind access" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Bind address" })).toHaveValue("127.0.0.1");
    expect(screen.getByLabelText("Port")).toHaveValue(7391);
    expect(screen.getByLabelText("Share URL")).toHaveValue("http://127.0.0.1:7391");
    expect(screen.getByText(/Non-local bind addresses allow/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy share URL" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save bind" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save bind" }));
    expect(saveRuntimeBind).toHaveBeenCalledWith("127.0.0.1", 7391);
    expect(
      await screen.findByText(
        "Runtime bind updated; restart the agent to move the listening socket.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bind" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const clipboard = screen.getByRole("button", { name: "Toggle clipboard sync" });
    expect(clipboard).toBeEnabled();
    expect(clipboard).toHaveAttribute("aria-pressed", "false");
    await user.click(clipboard);
    expect(saveRuntimeClipboard).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Clipboard sync enabled")).toBeInTheDocument();
    expect(clipboard).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Power" }));
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
    expect(await screen.findByText("Clipboard sync disabled")).toBeInTheDocument();
    expect(clipboard).toHaveAttribute("aria-pressed", "false");
    expect(clipboard).toHaveAttribute("title", "Clipboard sync disabled");
    expect(screen.queryByText(/policy/i)).not.toBeInTheDocument();
  });

  it("matches the design interaction contract for device menus and adb scanning", async () => {
    const user = userEvent.setup();
    const createdSessions: string[] = [];
    const renamed: Array<readonly [string, string]> = [];
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
          renameDevice: async (serial, alias) => {
            renamed.push([serial, alias]);
            return { message: "renamed", ok: true };
          },
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
        storage={createMemoryStorage()}
      />,
    );

    await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(screen.getByRole("button", { name: "Open Pixel 6 menu" }));
    let menu = screen.getByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Show device log" }));
    expect(await screen.findByText("Showing logs for Pixel 6")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Pixel 6 menu" }));
    menu = screen.getByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Rename device" }));
    await user.clear(screen.getByLabelText("Display name"));
    await user.type(screen.getByLabelText("Display name"), "Lab Pixel");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(renamed).toEqual([["R5CW70ABC12", "Lab Pixel"]]);

    await user.click(screen.getByRole("button", { name: "Open Lab Pixel menu" }));
    menu = screen.getByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Start session" }));
    expect(createdSessions).toEqual(["R5CW70ABC12"]);

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
          scanDevices: async () => [
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

    expect(await screen.findByText("Session s-emulator-5554")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Pixel 8 menu" }));
    expect(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Start session" }),
    ).toBeDisabled();
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
