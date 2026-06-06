import * as React from "react";
import {
  Activity,
  ArrowLeft,
  Camera,
  Check,
  Clipboard,
  Copy,
  Home,
  Keyboard,
  Menu,
  MonitorSmartphone,
  MoreVertical,
  Moon,
  Power,
  RotateCcw,
  RotateCw,
  Search,
  Smartphone,
  Square,
  Sun,
  Video,
  Volume2,
} from "lucide-react";
import {
  createFrameHeader,
  createSystemControlFrame,
  createVideoReconfigureFrame,
  encodeFrame,
  MessageType,
  StreamId,
  SystemControlAction,
} from "@droid-webscr/protocol";
import { Button } from "./components/ui/button.js";
import { createNativeVideoDecoderAdapter } from "./decoder/video-decoder.js";
import {
  createVideoPipeline,
  VideoPipeline,
  VideoPipelineSnapshot,
} from "./decoder/video-pipeline.js";
import { DeviceDescriptor } from "./features/devices/device-types.js";
import {
  AgentClient,
  createHttpAgentClient,
  RuntimeConfig,
} from "./features/session/agent-client.js";
import {
  reduceSessionState,
  SessionRecord,
  SessionState,
} from "./features/session/session-state.js";
import { mapKeyboardToControlFrame } from "./input/keyboard-mapper.js";
import { mapPointerToControlFrame, PointerAction } from "./input/pointer-mapper.js";
import { mapTextToControlFrame } from "./input/text-mapper.js";
import { createMemoryStorage, StorageLike } from "./lib/memory-storage.js";
import { cn } from "./lib/utils.js";
import { createCanvasRenderer } from "./renderer/canvas-renderer.js";
import { applyTheme, persistTheme, readTheme, ThemePreference } from "./theme/theme.js";
import { createSessionSocket, SessionSocket } from "./transport/session-socket.js";

export interface DroidWebscrAppProps {
  readonly client?: AgentClient | undefined;
  readonly initialLogs?: readonly string[] | undefined;
  readonly sessionSocketFactory?: ((session: SessionRecord) => SessionSocket) | undefined;
  readonly videoPipelineFactory?:
    | ((canvas: HTMLCanvasElement, onError: (message: string) => void) => VideoPipeline)
    | undefined;
  readonly storage?: StorageLike | undefined;
}

type LogLevel = "all" | "info" | "warn" | "error";
type DialogKind = "endpoint" | "rename" | "bind" | undefined;

const defaultSessionState: SessionState = {
  logs: [],
  phase: "idle",
  selectedSerial: undefined,
  session: undefined,
};

const fallbackRuntimeConfig: RuntimeConfig = {
  bindHost: "127.0.0.1",
  clipboardEnabled: false,
  port: 7391,
};

const designInitialLogs: readonly string[] = [
  "10:42:10.231 INFO   stream     Starting stream: 1344x2992@30fps bitrate=4Mbps transport=USB",
  "10:42:10.448 INFO   control    Input channel established",
  "10:42:11.004 WARN   encoder    Bitrate pressure detected; holding 4Mbps",
  "10:42:12.773 INFO   clipboard  Clipboard sync disabled by policy",
  "10:42:14.092 INFO   session    Agent ready",
];

export function DroidWebscrApp({
  client,
  initialLogs = designInitialLogs,
  sessionSocketFactory = createDefaultSessionSocket,
  videoPipelineFactory = createDefaultVideoPipeline,
  storage = browserStorage(),
}: DroidWebscrAppProps): React.ReactElement {
  const agentClient = React.useMemo(() => client ?? createHttpAgentClient(), [client]);
  const [devices, setDevices] = React.useState<readonly DeviceDescriptor[]>([]);
  const [loadingDevices, setLoadingDevices] = React.useState(true);
  const [runtimeConfig, setRuntimeConfig] = React.useState<RuntimeConfig>(fallbackRuntimeConfig);
  const [theme, setTheme] = React.useState<ThemePreference>(() => readTheme(storage));
  const [videoSnapshot, setVideoSnapshot] = React.useState<VideoPipelineSnapshot | undefined>();
  const [bitrateMbps, setBitrateMbps] = React.useState(4);
  const [fps, setFps] = React.useState(30);
  const [rotation, setRotation] = React.useState(0);
  const [recording, setRecording] = React.useState(false);
  const [dialog, setDialog] = React.useState<DialogKind>();
  const [dialogValue, setDialogValue] = React.useState("");
  const [toast, setToast] = React.useState<string | undefined>();
  const [logLevel, setLogLevel] = React.useState<LogLevel>("all");
  const [autoscroll, setAutoscroll] = React.useState(true);
  const [state, dispatch] = React.useReducer(reduceSessionState, {
    ...defaultSessionState,
    logs: initialLogs,
  });
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const textInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const sessionSocketRef = React.useRef<SessionSocket | undefined>(undefined);
  const videoPipelineRef = React.useRef<VideoPipeline | undefined>(undefined);
  const pointerIdRef = React.useRef(0);
  const sequenceRef = React.useRef(1n);
  const selectedDevice = devices.find((device) => device.serial === state.selectedSerial);
  const useDesignApiFallback = shouldUseDesignApiFallback(client);

  React.useEffect(() => {
    applyTheme(theme);
    persistTheme(storage, theme);
  }, [storage, theme]);

  const notify = React.useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(undefined), 1600);
  }, []);

  const refreshDevices = React.useCallback(async () => {
    setLoadingDevices(true);
    try {
      const nextDevices = await agentClient.listDevices();
      setDevices(nextDevices);
      const firstAuthorized = nextDevices.find(
        (device) => device.authorizationState === "authorized",
      );
      if (!state.selectedSerial && firstAuthorized) {
        dispatch({ serial: firstAuthorized.serial, type: "select-device" });
      }
    } catch (error) {
      if (isFrontendDevServerApiFallback(error)) {
        setDevices(designFallbackDevices());
        if (!state.selectedSerial) {
          dispatch({ serial: "192.168.1.42:5555", type: "select-device" });
        }
        return;
      }
      dispatch({
        message: error instanceof Error ? error.message : "Device listing failed",
        type: "failed",
      });
    } finally {
      setLoadingDevices(false);
    }
  }, [agentClient, state.selectedSerial]);

  React.useEffect(() => {
    void refreshDevices();
    if (!useDesignApiFallback) {
      void agentClient
        .getRuntimeConfig?.()
        .then(setRuntimeConfig)
        .catch(() => undefined);
    }
  }, [agentClient, refreshDevices, useDesignApiFallback]);

  const startSession = async () => {
    if (!state.selectedSerial) {
      return;
    }
    dispatch({ type: "start-requested" });
    try {
      const session = await agentClient.createSession(state.selectedSerial);
      dispatch({ session, type: "start-succeeded" });
      const socket = sessionSocketFactory(session);
      sessionSocketRef.current = socket;
      const canvas = canvasRef.current;
      if (canvas) {
        const pipeline = videoPipelineFactory(canvas, (message) => {
          dispatch({ message, type: "failed" });
        });
        videoPipelineRef.current = pipeline;
        socket.onFrame((frame) => {
          void pipeline.acceptFrame(frame).then((snapshot) => {
            setVideoSnapshot(snapshot);
            if (snapshot.pressure) {
              dispatch({ message: "Decode pressure detected", type: "log" });
            }
            if (snapshot.lastError) {
              dispatch({ message: `ERROR ${snapshot.lastError}`, type: "log" });
            }
          });
        });
      }
      await socket.waitUntilOpen();
      await socket.send(createSessionHelloFrame(nextSequence(sequenceRef)));
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : "Session creation failed",
        type: "failed",
      });
    }
  };

  const stopSession = React.useCallback(() => {
    sessionSocketRef.current?.close();
    sessionSocketRef.current = undefined;
    videoPipelineRef.current?.close();
    videoPipelineRef.current = undefined;
    setVideoSnapshot(undefined);
    setRecording(false);
    dispatch({ type: "stop" });
  }, []);

  const sendControlFrame = React.useCallback(async (frame: Uint8Array) => {
    await sessionSocketRef.current?.send(frame);
  }, []);

  const sendSystemAction = React.useCallback(
    (action: SystemControlAction) => {
      void sendControlFrame(
        createSystemControlFrame(action, { sequence: nextSequence(sequenceRef) }),
      );
      notify(`Sent ${action}`);
    },
    [notify, sendControlFrame],
  );

  const sendVideoReconfigure = React.useCallback(
    (nextBitrate: number, nextFps: number) => {
      setBitrateMbps(nextBitrate);
      setFps(nextFps);
      void sendControlFrame(
        createVideoReconfigureFrame({
          bitrateMbps: nextBitrate,
          fps: nextFps,
          sequence: nextSequence(sequenceRef),
        }),
      );
      dispatch({ message: `INFO Video ${nextBitrate} Mbps ${nextFps} FPS`, type: "log" });
    },
    [sendControlFrame],
  );

  const captureFrame = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const url = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = "droid-webscr-capture.png";
    link.href = url;
    link.click();
    notify("Capture saved");
  }, [notify]);

  const toggleRecording = React.useCallback(() => {
    setRecording((current) => !current);
    dispatch({
      message: recording ? "INFO Recording stopped" : "INFO Recording started",
      type: "log",
    });
  }, [recording]);

  const scanDevices = React.useCallback(async () => {
    try {
      setLoadingDevices(true);
      const nextDevices = await (agentClient.scanDevices?.() ?? agentClient.listDevices());
      setDevices(nextDevices);
      notify("ADB scan complete");
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : "Device scan failed",
        type: "failed",
      });
    } finally {
      setLoadingDevices(false);
    }
  }, [agentClient, notify]);

  const submitDialog = React.useCallback(async () => {
    const value = dialogValue.trim();
    if (!value) {
      return;
    }
    try {
      if (dialog === "endpoint") {
        await agentClient.connectEndpoint?.(value);
        notify("Endpoint connected");
        await scanDevices();
      }
      if (dialog === "rename" && selectedDevice) {
        await agentClient.renameDevice?.(selectedDevice.serial, value);
        setDevices((current) =>
          current.map((device) =>
            device.serial === selectedDevice.serial ? { ...device, model: value } : device,
          ),
        );
        notify("Device renamed");
      }
      if (dialog === "bind") {
        notify(`Bind remains ${runtimeConfig.bindHost}:${runtimeConfig.port}`);
      }
      setDialog(undefined);
      setDialogValue("");
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : "Agent operation failed",
        type: "failed",
      });
    }
  }, [agentClient, dialog, dialogValue, notify, runtimeConfig, scanDevices, selectedDevice]);

  const sendKey = React.useCallback(
    (event: React.KeyboardEvent) => {
      const frame = mapKeyboardToControlFrame({
        action: event.type === "keydown" ? "down" : "up",
        code: event.code,
        metaState: event.shiftKey ? 1 : 0,
        repeat: event.repeat ? 1 : 0,
        sequence: nextSequence(sequenceRef),
      });
      if (frame) {
        event.preventDefault();
        void sendControlFrame(frame);
      }
    },
    [sendControlFrame],
  );

  const sendTextValue = React.useCallback(
    (text: string | undefined) => {
      if (!text) {
        return;
      }
      void sendControlFrame(mapTextToControlFrame({ sequence: nextSequence(sequenceRef), text }));
    },
    [sendControlFrame],
  );

  const sendText = React.useCallback(
    (event: React.FormEvent<HTMLElement>) => {
      const text = extractInsertedText(event.nativeEvent);
      if (!text) {
        return;
      }
      event.preventDefault();
      sendTextValue(text);
    },
    [sendTextValue],
  );

  const sendPointer = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, action: PointerAction) => {
      const size = videoSnapshot?.videoSize ?? { height: 1280, width: 720 };
      const rect = event.currentTarget.getBoundingClientRect();
      const frame = mapPointerToControlFrame({
        action,
        buttons: event.buttons,
        display: { height: size.height, rotation: normalizeRotation(rotation), width: size.width },
        pointerId: pointerIdRef.current,
        pressure: event.pressure || 1,
        sequence: nextSequence(sequenceRef),
        viewport: { height: rect.height, left: rect.left, top: rect.top, width: rect.width },
        x: event.clientX,
        y: event.clientY,
      });
      if (action === "up" || action === "cancel") {
        pointerIdRef.current = (pointerIdRef.current + 1) % 10;
      }
      void sendControlFrame(frame);
    },
    [rotation, sendControlFrame, videoSnapshot?.videoSize],
  );

  React.useEffect(
    () => () => {
      sessionSocketRef.current?.close();
      videoPipelineRef.current?.close();
    },
    [],
  );

  return (
    <main className="app-shell min-h-screen bg-background text-foreground">
      <Topbar
        bitrateMbps={bitrateMbps}
        fps={fps}
        onCapture={captureFrame}
        onReconfigure={sendVideoReconfigure}
        onRecord={toggleRecording}
        onRotate={(delta) => setRotation((current) => (current + delta + 360) % 360)}
        onStart={() => void startSession()}
        onStop={stopSession}
        onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        phase={state.phase}
        recording={recording}
        selectedDevice={selectedDevice}
        session={state.session}
        theme={theme}
      />
      <div className="main-grid">
        <Sidebar
          devices={devices}
          loading={loadingDevices}
          onConnectEndpoint={() => {
            setDialog("endpoint");
            setDialogValue("");
          }}
          onDisconnect={async (serial) => {
            await agentClient.disconnectDevice?.(serial);
            notify("Device disconnected");
            await scanDevices();
          }}
          onRefresh={() => void scanDevices()}
          onRename={() => {
            setDialog("rename");
            setDialogValue(selectedDevice?.model ?? "");
          }}
          onSelect={(serial) => dispatch({ serial, type: "select-device" })}
          selectedSerial={state.selectedSerial}
          accessPanel={
            <AccessPanel
              clipboardEnabled={runtimeConfig.clipboardEnabled}
              host={runtimeConfig.bindHost}
              onBind={() => {
                setDialog("bind");
                setDialogValue(`${runtimeConfig.bindHost}:${runtimeConfig.port}`);
              }}
              port={runtimeConfig.port}
            />
          }
        />
        <section className="viewport-grid bg-viewport">
          <AndroidViewport
            canvasRef={canvasRef}
            device={selectedDevice}
            onBeforeInput={sendText}
            onCompositionEnd={(event) => sendTextValue(event.data)}
            onKeyDown={sendKey}
            onKeyUp={sendKey}
            onPointerCancel={(event) => sendPointer(event, "cancel")}
            onPointerDown={(event) => sendPointer(event, "down")}
            onPointerMove={(event) => {
              if (event.buttons !== 0) {
                sendPointer(event, "move");
              }
            }}
            onPointerUp={(event) => sendPointer(event, "up")}
            rotation={rotation}
            textInputRef={textInputRef}
            videoSnapshot={videoSnapshot}
          />
          <AndroidControls onSystemAction={sendSystemAction} />
        </section>
      </div>
      <LogDrawer
        autoscroll={autoscroll}
        level={logLevel}
        logs={state.logs}
        onAutoscrollChange={setAutoscroll}
        onClear={() => dispatch({ type: "clear-logs" })}
        onLevelChange={setLogLevel}
      />
      {dialog ? (
        <Dialog
          kind={dialog}
          onCancel={() => setDialog(undefined)}
          onSubmit={() => void submitDialog()}
          onValueChange={setDialogValue}
          value={dialogValue}
        />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}

function Topbar({
  bitrateMbps,
  fps,
  onCapture,
  onReconfigure,
  onRecord,
  onRotate,
  onStart,
  onStop,
  onTheme,
  phase,
  recording,
  selectedDevice,
  session,
  theme,
}: {
  readonly bitrateMbps: number;
  readonly fps: number;
  readonly onCapture: () => void;
  readonly onReconfigure: (bitrateMbps: number, fps: number) => void;
  readonly onRecord: () => void;
  readonly onRotate: (delta: number) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onTheme: () => void;
  readonly phase: SessionState["phase"];
  readonly recording: boolean;
  readonly selectedDevice: DeviceDescriptor | undefined;
  readonly session: SessionRecord | undefined;
  readonly theme: ThemePreference;
}): React.ReactElement {
  const canStart = selectedDevice?.authorizationState === "authorized" && phase !== "starting";
  return (
    <header className="topbar">
      <Button aria-label="Toggle sidebar" size="icon" variant="ghost">
        <Menu aria-hidden="true" />
      </Button>
      <div className="brand">
        <MonitorSmartphone aria-hidden="true" />
        <div>
          <h1>droid-webscr</h1>
          <span>v0.8.2</span>
        </div>
      </div>
      <span aria-label="Session status" className="session-status" hidden>
        {session ? `Session ${session.sessionId}` : "No session"}
      </span>
      {session ? (
        <Button onClick={onStop} variant="outline">
          <Square aria-hidden="true" data-icon="inline-start" />
          Stop
        </Button>
      ) : (
        <Button aria-label="Start" disabled={!canStart} onClick={onStart}>
          <Power aria-hidden="true" data-icon="inline-start" />
          Start
        </Button>
      )}
      <div className="topbar-group">
        <Button
          aria-label="Rotate left"
          onClick={() => onRotate(-90)}
          size="icon"
          variant="outline"
        >
          <RotateCcw aria-hidden="true" />
        </Button>
        <Button
          aria-label="Rotate right"
          onClick={() => onRotate(90)}
          size="icon"
          variant="outline"
        >
          <RotateCw aria-hidden="true" />
        </Button>
      </div>
      <label className="select-label">
        Bitrate
        <select
          aria-label="Bitrate"
          onChange={(event) => onReconfigure(Number(event.target.value), fps)}
          value={bitrateMbps}
        >
          <option value={4}>4 Mbps</option>
          <option value={8}>8 Mbps</option>
          <option value={12}>12 Mbps</option>
        </select>
      </label>
      <label className="select-label">
        FPS
        <select
          aria-label="FPS"
          onChange={(event) => onReconfigure(bitrateMbps, Number(event.target.value))}
          value={fps}
        >
          <option value={30}>30 fps</option>
          <option value={45}>45 fps</option>
          <option value={60}>60 fps</option>
        </select>
      </label>
      <div className="topbar-spacer" />
      <Button
        aria-label={theme === "dark" ? "Light theme" : "Dark theme"}
        onClick={onTheme}
        size="icon"
        variant="outline"
      >
        {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </Button>
      <Button aria-label="Capture" onClick={onCapture} size="icon" variant="outline">
        <Camera aria-hidden="true" />
      </Button>
      <Button
        aria-label={recording ? "Stop recording" : "Record"}
        onClick={onRecord}
        size="icon"
        variant="outline"
      >
        <Video aria-hidden="true" />
      </Button>
      <Button aria-label="More actions" size="icon" variant="ghost">
        <MoreVertical aria-hidden="true" />
      </Button>
    </header>
  );
}

function Sidebar({
  accessPanel,
  devices,
  loading,
  onConnectEndpoint,
  onDisconnect,
  onRefresh,
  onRename,
  onSelect,
  selectedSerial,
}: {
  readonly accessPanel: React.ReactNode;
  readonly devices: readonly DeviceDescriptor[];
  readonly loading: boolean;
  readonly onConnectEndpoint: () => void;
  readonly onDisconnect: (serial: string) => Promise<void>;
  readonly onRefresh: () => void;
  readonly onRename: () => void;
  readonly onSelect: (serial: string) => void;
  readonly selectedSerial: string | undefined;
}): React.ReactElement {
  const [openSerial, setOpenSerial] = React.useState<string | undefined>();
  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="section-heading">
          <h2>DEVICES</h2>
          <span>{devices.length} connected</span>
        </div>
        <div className="device-list">
          {devices.length === 0 ? (
            <div className="empty-state">
              {loading ? "Scanning devices" : "No Android devices detected"}
            </div>
          ) : (
            devices.map((device) => (
              <div
                className={cn("device-card", selectedSerial === device.serial && "selected")}
                key={device.serial}
              >
                <div className="device-card-main">
                  <button
                    aria-label={`${device.model ?? "Android device"} ${device.serial}`}
                    onClick={() => onSelect(device.serial)}
                    type="button"
                  >
                    <Smartphone aria-hidden="true" />
                    <span>
                      <strong>{device.model ?? "Android device"}</strong>
                      <small>{device.serial}</small>
                      <small className="device-state">
                        <span className="status-dot" />
                        {device.authorizationState}
                      </small>
                    </span>
                    {selectedSerial === device.serial ? <Check aria-hidden="true" /> : null}
                  </button>
                  <Button
                    aria-expanded={openSerial === device.serial}
                    aria-label={`Open ${device.model ?? device.serial} menu`}
                    onClick={() => {
                      setOpenSerial((current) =>
                        current === device.serial ? undefined : device.serial,
                      );
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <MoreVertical aria-hidden="true" />
                  </Button>
                </div>
                <div className="device-menu" hidden={openSerial !== device.serial}>
                  <button onClick={() => onSelect(device.serial)} type="button">
                    Start session
                  </button>
                  <button type="button">Show device log</button>
                  <button onClick={onRename} type="button">
                    Rename device
                  </button>
                  <button onClick={() => void onDisconnect(device.serial)} type="button">
                    Disconnect
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="sidebar-section">
        <h2>ADD DEVICE</h2>
        <Button onClick={onRefresh} variant="outline">
          <Search aria-hidden="true" data-icon="inline-start" />
          Scan adb devices
        </Button>
        <Button onClick={onConnectEndpoint} variant="secondary">
          <Copy aria-hidden="true" data-icon="inline-start" />
          Connect by endpoint
        </Button>
      </div>
      {accessPanel}
    </aside>
  );
}

function AccessPanel({
  clipboardEnabled,
  host,
  onBind,
  port,
}: {
  readonly clipboardEnabled: boolean;
  readonly host: string;
  readonly onBind: () => void;
  readonly port: number;
}): React.ReactElement {
  return (
    <section className="access-panel">
      <h2>ACCESS</h2>
      <button className="access-row access-action" onClick={onBind} type="button">
        <span>Bind</span>
        <strong>{host}</strong>
        <span aria-hidden="true">&gt;</span>
      </button>
      <span className="compat-text">
        Bind {host}:{port}
      </span>
      <span className="compat-text">Bind {host}</span>
      <button
        aria-label={clipboardEnabled ? "Clipboard on" : "Clipboard off"}
        className="access-row access-action"
        disabled={!clipboardEnabled}
        type="button"
      >
        <span>
          <Clipboard aria-hidden="true" data-icon="inline-start" />
          Clipboard
        </span>
        <span className={cn("switch-pill", clipboardEnabled && "on")}>
          <span />
        </span>
      </button>
    </section>
  );
}

function AndroidViewport({
  canvasRef,
  device,
  onCompositionEnd,
  onKeyDown,
  onKeyUp,
  onBeforeInput,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  rotation,
  textInputRef,
  videoSnapshot,
}: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly device: DeviceDescriptor | undefined;
  readonly onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
  readonly onBeforeInput: (event: React.FormEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: React.KeyboardEvent) => void;
  readonly onKeyUp: (event: React.KeyboardEvent) => void;
  readonly onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  readonly onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  readonly onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  readonly onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  readonly rotation: number;
  readonly textInputRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly videoSnapshot: VideoPipelineSnapshot | undefined;
}): React.ReactElement {
  const status = describeVideoStatus(videoSnapshot);
  return (
    <section aria-label="Android screen viewport" className="stage">
      <div className="phone-shell" style={{ transform: `rotate(${rotation}deg)` }}>
        <div className="phone-statusbar">
          <span>10:42</span>
          <span title={device?.serial ?? "waiting"}>Wi-Fi 100%</span>
          <span>100%</span>
        </div>
        {videoSnapshot?.lastError ? <small className="compat-text">{status.detail}</small> : null}
        <span className="compat-text">{status.title}</span>
        <div className="phone-screen">
          <canvas
            aria-label="Android video canvas"
            className="video-canvas"
            onBeforeInput={onBeforeInput}
            onInput={onBeforeInput}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onPointerCancel={onPointerCancel}
            onPointerDown={(event) => {
              textInputRef.current?.focus();
              onPointerDown(event);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            ref={canvasRef}
            tabIndex={0}
          />
          <textarea
            aria-label="Android text input"
            autoCapitalize="off"
            autoCorrect="off"
            className="hidden-text-input"
            onBeforeInput={onBeforeInput}
            onCompositionEnd={onCompositionEnd}
            onInput={onBeforeInput}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            ref={textInputRef}
            spellCheck={false}
            tabIndex={-1}
          />
          {videoSnapshot?.configured ? null : <MockAndroidHome status={status} />}
        </div>
      </div>
    </section>
  );
}

function MockAndroidHome({
  status,
}: {
  readonly status: { readonly detail: string; readonly title: string };
}): React.ReactElement {
  return (
    <div className="mock-home">
      <div className="weather">
        <span>Fri, May 24</span>
        <strong>18 C</strong>
      </div>
      <div className="app-grid">
        {["Play Store", "Gmail", "Photos", "YouTube", "Phone", "Messages", "Chrome", "Camera"].map(
          (label) => (
            <div className="mock-app" key={label}>
              <span>{label.charAt(label === "Play Store" ? 2 : 0)}</span>
              <small>{label}</small>
            </div>
          ),
        )}
      </div>
      <div className="searchbar">
        <span>G</span>
        <strong>Mic Lens</strong>
      </div>
      <div className="gesture" />
      <div className="viewport-status compat-text">
        <Activity aria-hidden="true" />
        <strong>{status.title}</strong>
        <small>{status.detail}</small>
      </div>
    </div>
  );
}

function AndroidControls({
  onSystemAction,
}: {
  readonly onSystemAction: (action: SystemControlAction) => void;
}): React.ReactElement {
  const controls: ReadonlyArray<readonly [string, SystemControlAction, typeof Keyboard]> = [
    ["Keyboard", "keyboard", Keyboard],
    ["Home", "home", Home],
    ["Back", "back", ArrowLeft],
    ["Overview", "overview", MonitorSmartphone],
    ["Volume", "volume-up", Volume2],
    ["Power", "power", Power],
  ];
  return (
    <nav className="control-rail">
      {controls.map(([label, action, Icon]) => (
        <Button
          aria-label={label}
          key={label}
          onClick={() => onSystemAction(action)}
          size="icon"
          variant="outline"
        >
          <Icon aria-hidden="true" />
        </Button>
      ))}
    </nav>
  );
}

function LogDrawer({
  autoscroll,
  level,
  logs,
  onAutoscrollChange,
  onClear,
  onLevelChange,
}: {
  readonly autoscroll: boolean;
  readonly level: LogLevel;
  readonly logs: readonly string[];
  readonly onAutoscrollChange: (enabled: boolean) => void;
  readonly onClear: () => void;
  readonly onLevelChange: (level: LogLevel) => void;
}): React.ReactElement {
  const visibleLogs = logs.filter((log) => level === "all" || log.toLowerCase().startsWith(level));
  return (
    <section aria-label="Log drawer" className="log-drawer">
      <div className="drawer-resizer" />
      <div className="log-toolbar">
        <h2>AGENT LOG</h2>
        <label>
          Level
          <select
            aria-label="Log level"
            onChange={(event) => onLevelChange(event.target.value as LogLevel)}
            value={level}
          >
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label className="switch">
          <input
            checked={autoscroll}
            onChange={(event) => onAutoscrollChange(event.target.checked)}
            type="checkbox"
          />
          Autoscroll
        </label>
        <Button aria-label="Clear logs" onClick={onClear} size="sm" variant="outline">
          Clear
        </Button>
      </div>
      <div className="log-lines">
        {visibleLogs.length === 0 ? (
          <p>No logs</p>
        ) : (
          visibleLogs.map((log, index) => <p key={`${log}-${index}`}>{log}</p>)
        )}
      </div>
    </section>
  );
}

function Dialog({
  kind,
  onCancel,
  onSubmit,
  onValueChange,
  value,
}: {
  readonly kind: Exclude<DialogKind, undefined>;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly onValueChange: (value: string) => void;
  readonly value: string;
}): React.ReactElement {
  const title =
    kind === "endpoint"
      ? "Connect by endpoint"
      : kind === "rename"
        ? "Rename device"
        : "Bind address";
  return (
    <div aria-label={title} className="dialog-backdrop" role="dialog">
      <div className="dialog">
        <h2>{title}</h2>
        <input
          autoFocus
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={kind === "endpoint" ? "192.168.1.40:5555" : "Value"}
          value={value}
        />
        <div>
          <Button onClick={onCancel} variant="outline">
            Cancel
          </Button>
          <Button onClick={onSubmit}>Apply</Button>
        </div>
      </div>
    </div>
  );
}

function browserStorage(): StorageLike {
  if (typeof window === "undefined") {
    return createMemoryStorage();
  }
  return window.localStorage;
}

function shouldUseDesignApiFallback(client: AgentClient | undefined): boolean {
  return (
    client === undefined &&
    typeof window !== "undefined" &&
    window.location.hostname === "localhost" &&
    window.location.port === "5173"
  );
}

function isFrontendDevServerApiFallback(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("Agent API did not return") ||
      error.message.includes("Device listing failed with HTTP 404"))
  );
}

function designFallbackDevices(): readonly DeviceDescriptor[] {
  return [
    {
      authorizationState: "authorized",
      model: "Pixel 8 Pro",
      serial: "192.168.1.42:5555",
      transportKind: "network",
    },
    {
      authorizationState: "authorized",
      model: "Pixel 6a",
      serial: "192.168.1.45:5555",
      transportKind: "network",
    },
  ];
}

function createDefaultSessionSocket(session: SessionRecord): SessionSocket {
  return createSessionSocket(
    `/ws/session/${encodeURIComponent(session.sessionId)}?token=${encodeURIComponent(session.token)}`,
  );
}

function createDefaultVideoPipeline(
  canvas: HTMLCanvasElement,
  onError: (message: string) => void,
): VideoPipeline {
  const renderer = createCanvasRenderer(canvas);
  return createVideoPipeline({
    createDecoder: () =>
      createNativeVideoDecoderAdapter(
        (frame) => renderer.render(frame),
        (error) => onError(error.message),
      ),
    onVideoConfig: (size) => renderer.resize(size),
  });
}

function createSessionHelloFrame(sequence: bigint): Uint8Array {
  return encodeFrame({
    header: createFrameHeader({
      sequence,
      streamId: StreamId.Session,
      type: MessageType.SessionHello,
    }),
    payload: new Uint8Array(),
  });
}

function nextSequence(sequence: React.MutableRefObject<bigint>): bigint {
  const current = sequence.current;
  sequence.current += 1n;
  return current;
}

function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function extractInsertedText(event: Event): string | undefined {
  const inputEvent = event as Event & {
    readonly data?: string | null | undefined;
    readonly inputType?: string | undefined;
  };
  if (!inputEvent.inputType?.startsWith("insert")) {
    return undefined;
  }
  return inputEvent.data && inputEvent.data.length > 0 ? inputEvent.data : undefined;
}

function describeVideoStatus(snapshot: VideoPipelineSnapshot | undefined): {
  readonly detail: string;
  readonly title: string;
} {
  if (!snapshot) {
    return { detail: "Video decoder boundary ready", title: "Viewport fit active" };
  }
  if (snapshot.status === "unsupported") {
    return { detail: snapshot.lastError ?? "Use Chrome or Edge", title: "WebCodecs unsupported" };
  }
  if (snapshot.status === "error") {
    return { detail: snapshot.lastError ?? "Decoder failed", title: "Video unavailable" };
  }
  if (snapshot.pressure) {
    return { detail: "Dropping frames to keep latency bounded", title: "Decode pressure" };
  }
  return { detail: "Receiving Android video", title: "Video ready" };
}
