import * as React from "react";
import {
  Activity,
  ArrowLeft,
  Camera,
  Check,
  Circle,
  Clipboard,
  Home,
  Keyboard,
  List,
  Menu,
  MonitorSmartphone,
  MoreVertical,
  Moon,
  Power,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  Smartphone,
  Square,
  Sun,
  Video,
  Volume2,
  Wifi,
  Trash2,
} from "lucide-react";
import {
  createFrameHeader,
  decodeFrame,
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
type DialogKind =
  | "adb-scan"
  | "endpoint"
  | "rename"
  | "bind"
  | "power"
  | "session-actions"
  | undefined;

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
  "10:42:12.773 INFO   clipboard  Clipboard sync disabled",
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
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [dialog, setDialog] = React.useState<DialogKind>();
  const [dialogValue, setDialogValue] = React.useState("");
  const [bindHostDraft, setBindHostDraft] = React.useState(fallbackRuntimeConfig.bindHost);
  const [bindPortDraft, setBindPortDraft] = React.useState(String(fallbackRuntimeConfig.port));
  const [shareUrl, setShareUrl] = React.useState(
    createShareUrl(fallbackRuntimeConfig.bindHost, fallbackRuntimeConfig.port),
  );
  const [selectedAdbSerial, setSelectedAdbSerial] = React.useState<string | undefined>();
  const [adbDialogDevices, setAdbDialogDevices] = React.useState<readonly DeviceDescriptor[]>([]);
  const [dialogDeviceSerial, setDialogDeviceSerial] = React.useState<string | undefined>();
  const [toast, setToast] = React.useState<string | undefined>();
  const [logLevel, setLogLevel] = React.useState<LogLevel>("all");
  const [autoscroll, setAutoscroll] = React.useState(true);
  const [logHeight, setLogHeight] = React.useState(136);
  const [logResizing, setLogResizing] = React.useState(false);
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
  const appStyle = React.useMemo(
    () => ({ "--log-height": `${logHeight}px` }) as React.CSSProperties,
    [logHeight],
  );

  React.useEffect(() => {
    applyTheme(theme);
    persistTheme(storage, theme);
  }, [storage, theme]);

  const notify = React.useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(undefined), 1600);
  }, []);

  const setLogHeightFromClientY = React.useCallback((clientY: number) => {
    const nextHeight = Math.round(window.innerHeight - clientY);
    setLogHeight(Math.max(88, Math.min(360, nextHeight)));
  }, []);

  React.useEffect(() => {
    if (!logResizing) {
      return undefined;
    }
    const onPointerMove = (event: PointerEvent) => setLogHeightFromClientY(event.clientY);
    const onMouseMove = (event: MouseEvent) => setLogHeightFromClientY(event.clientY);
    const stopResize = () => setLogResizing(false);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopResize);
    };
  }, [logResizing, setLogHeightFromClientY]);

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
        .then((config) => {
          setRuntimeConfig(config);
          setBindHostDraft(config.bindHost);
          setBindPortDraft(String(config.port));
          setShareUrl(createShareUrl(config.bindHost, config.port));
        })
        .catch(() => undefined);
      void agentClient
        .shareUrl?.()
        .then((result) => setShareUrl(result.url))
        .catch(() => undefined);
    }
  }, [agentClient, refreshDevices, useDesignApiFallback]);

  const openBindDialog = React.useCallback(() => {
    setBindHostDraft(runtimeConfig.bindHost);
    setBindPortDraft(String(runtimeConfig.port));
    setShareUrl(createShareUrl(runtimeConfig.bindHost, runtimeConfig.port));
    void agentClient
      .shareUrl?.()
      .then((result) => setShareUrl(result.url))
      .catch(() => undefined);
    setDialog("bind");
  }, [agentClient, runtimeConfig]);

  const startSessionForSerial = React.useCallback(
    async (serial: string | undefined) => {
      if (!serial || state.phase === "starting" || state.session) {
        return;
      }
      dispatch({ serial, type: "select-device" });
      dispatch({ type: "start-requested" });
      try {
        const session = await agentClient.createSession(serial);
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
            const decoded = decodeFrame(frame);
            if (
              decoded.ok &&
              decoded.value.header.type === MessageType.LogRecord &&
              decoded.value.header.streamId === StreamId.Log
            ) {
              dispatch({ message: new TextDecoder().decode(decoded.value.payload), type: "log" });
              return;
            }
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
    },
    [agentClient, sessionSocketFactory, state.phase, state.session, videoPipelineFactory],
  );

  const startSession = React.useCallback(
    async () => startSessionForSerial(state.selectedSerial),
    [startSessionForSerial, state.selectedSerial],
  );

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

  const requestSystemAction = React.useCallback(
    (action: SystemControlAction) => {
      if (action === "power") {
        setDialog("power");
        return;
      }
      sendSystemAction(action);
    },
    [sendSystemAction],
  );

  const toggleClipboardSync = React.useCallback(async () => {
    const enabled = !runtimeConfig.clipboardEnabled;
    try {
      const result = await agentClient.saveRuntimeClipboard?.(enabled);
      const nextEnabled = result?.clipboardEnabled ?? enabled;
      setRuntimeConfig((current) => ({
        ...current,
        bindHost: result?.bindHost ?? current.bindHost,
        clipboardEnabled: nextEnabled,
        port: result?.port ?? current.port,
      }));
      dispatch({
        message: result?.message ?? `INFO Clipboard sync ${nextEnabled ? "enabled" : "disabled"}`,
        type: "log",
      });
      notify(`Clipboard ${nextEnabled ? "enabled" : "disabled"}`);
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : "Clipboard update failed",
        type: "failed",
      });
    }
  }, [agentClient, notify, runtimeConfig.clipboardEnabled]);

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

  const scanDevices = React.useCallback(async (): Promise<
    readonly DeviceDescriptor[] | undefined
  > => {
    try {
      setLoadingDevices(true);
      const nextDevices = await (agentClient.scanDevices?.() ?? agentClient.listDevices());
      setDevices(nextDevices);
      notify("ADB scan complete");
      return nextDevices;
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : "Device scan failed",
        type: "failed",
      });
      return undefined;
    } finally {
      setLoadingDevices(false);
    }
  }, [agentClient, notify]);

  const submitDialog = React.useCallback(async () => {
    const value = dialogValue.trim();
    if ((dialog === "endpoint" || dialog === "rename") && !value) {
      return;
    }
    try {
      if (dialog === "endpoint") {
        await agentClient.connectEndpoint?.(value);
        notify("Endpoint connected");
        await scanDevices();
      }
      const dialogDevice =
        devices.find((device) => device.serial === dialogDeviceSerial) ?? selectedDevice;
      if (dialog === "rename" && dialogDevice) {
        await agentClient.renameDevice?.(dialogDevice.serial, value);
        setDevices((current) =>
          current.map((device) =>
            device.serial === dialogDevice.serial ? { ...device, model: value } : device,
          ),
        );
        notify("Device renamed");
      }
      if (dialog === "bind") {
        const bindHost = bindHostDraft.trim();
        const bindPort = Number(bindPortDraft);
        const host = bindHost.length > 0 ? bindHost : runtimeConfig.bindHost;
        const port = Number.isFinite(bindPort) && bindPort > 0 ? bindPort : runtimeConfig.port;
        const result = await agentClient.saveRuntimeBind?.(host, port);
        setRuntimeConfig((current) => ({
          ...current,
          bindHost: result?.bindHost ?? host,
          clipboardEnabled: result?.clipboardEnabled ?? current.clipboardEnabled,
          port: result?.port ?? port,
        }));
        setShareUrl(result?.shareUrl ?? createShareUrl(host, port));
        dispatch({
          message:
            result?.message ?? `WARN Agent bind address set to ${host}:${port}; restart required`,
          type: "log",
        });
        notify(result?.ok ? "Bind updated" : "Bind saved locally");
      }
      if (dialog === "power") {
        sendSystemAction("power");
      }
      if (dialog === "session-actions") {
        notify("Session actions saved");
      }
      if (dialog === "adb-scan" && selectedAdbSerial) {
        const selectedScannedDevice = adbDialogDevices.find(
          (device) => device.serial === selectedAdbSerial,
        );
        if (selectedScannedDevice) {
          dispatch({ serial: selectedScannedDevice.serial, type: "select-device" });
          notify("ADB device connected");
        }
      }
      setDialog(undefined);
      setAdbDialogDevices([]);
      setDialogValue("");
      setDialogDeviceSerial(undefined);
      setSelectedAdbSerial(undefined);
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : "Agent operation failed",
        type: "failed",
      });
    }
  }, [
    agentClient,
    adbDialogDevices,
    bindHostDraft,
    bindPortDraft,
    devices,
    dialog,
    dialogDeviceSerial,
    dialogValue,
    notify,
    runtimeConfig,
    scanDevices,
    selectedAdbSerial,
    selectedDevice,
    sendSystemAction,
  ]);

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
    <main
      className={cn(
        "app-shell min-h-screen bg-background text-foreground",
        sidebarCollapsed && "sidebar-collapsed",
      )}
      style={appStyle}
    >
      <Topbar
        bitrateMbps={bitrateMbps}
        fps={fps}
        onCapture={captureFrame}
        onReconfigure={sendVideoReconfigure}
        onRecord={toggleRecording}
        onRotate={(delta) => setRotation((current) => (current + delta + 360) % 360)}
        onSessionActions={() => setDialog("session-actions")}
        onStart={() => void startSession()}
        onStop={stopSession}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        phase={state.phase}
        recording={recording}
        selectedDevice={selectedDevice}
        session={state.session}
        sidebarCollapsed={sidebarCollapsed}
        theme={theme}
      />
      <div className="main-grid">
        {sidebarCollapsed ? null : (
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
            onOpenAdbScan={() => {
              void scanDevices().then((nextDevices) => {
                if (!nextDevices) {
                  return;
                }
                setAdbDialogDevices(nextDevices);
                setSelectedAdbSerial(nextDevices[0]?.serial);
                setDialog("adb-scan");
              });
            }}
            onRename={(device) => {
              setDialogDeviceSerial(device.serial);
              setDialog("rename");
              setDialogValue(device.model ?? "");
            }}
            onSelect={(serial) => dispatch({ serial, type: "select-device" })}
            onShowDeviceLog={(device) => {
              const label = device.model ?? device.serial;
              dispatch({ message: `INFO Showing logs for ${label}`, type: "log" });
              notify(`Showing logs for ${label}`);
            }}
            onStartSession={(device) => void startSessionForSerial(device.serial)}
            sessionActive={Boolean(state.session) || state.phase === "starting"}
            selectedSerial={state.selectedSerial}
            accessPanel={
              <AccessPanel
                clipboardEnabled={runtimeConfig.clipboardEnabled}
                host={runtimeConfig.bindHost}
                onBind={openBindDialog}
                onClipboardToggle={toggleClipboardSync}
                port={runtimeConfig.port}
              />
            }
          />
        )}
        <section className="viewport-grid bg-viewport">
          <div className={cn("stage-pair", isLandscapeRotation(rotation) && "is-landscape")}>
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
            <AndroidControls onSystemAction={requestSystemAction} />
          </div>
        </section>
      </div>
      <LogDrawer
        autoscroll={autoscroll}
        level={logLevel}
        logs={state.logs}
        resizing={logResizing}
        onAutoscrollChange={setAutoscroll}
        onClear={() => dispatch({ type: "clear-logs" })}
        onLevelChange={setLogLevel}
        onResizeStart={(clientY) => {
          setLogHeightFromClientY(clientY);
          setLogResizing(true);
        }}
      />
      {dialog ? (
        <Dialog
          kind={dialog}
          bindHost={bindHostDraft}
          bindPort={bindPortDraft}
          clipboardEnabled={runtimeConfig.clipboardEnabled}
          devices={dialog === "adb-scan" ? adbDialogDevices : devices}
          onCancel={() => {
            setDialog(undefined);
            setAdbDialogDevices([]);
            setDialogDeviceSerial(undefined);
            setSelectedAdbSerial(undefined);
          }}
          onCopyShareUrl={() => {
            void navigator.clipboard?.writeText(shareUrl);
            notify("Share URL copied");
          }}
          onRefreshDevices={() => {
            void scanDevices().then((nextDevices) => {
              if (!nextDevices) {
                setAdbDialogDevices([]);
                setSelectedAdbSerial(undefined);
                return;
              }
              setAdbDialogDevices(nextDevices);
              setSelectedAdbSerial((current) =>
                nextDevices.some((device) => device.serial === current)
                  ? current
                  : nextDevices[0]?.serial,
              );
            });
          }}
          onSelectAdbDevice={setSelectedAdbSerial}
          onSubmit={() => void submitDialog()}
          onBindHostChange={(value) => {
            setBindHostDraft(value);
            setShareUrl(createShareUrl(value, Number(bindPortDraft)));
          }}
          onBindPortChange={(value) => {
            setBindPortDraft(value);
            setShareUrl(createShareUrl(bindHostDraft, Number(value)));
          }}
          onValueChange={setDialogValue}
          selectedAdbSerial={selectedAdbSerial}
          shareUrl={shareUrl}
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
  onSessionActions,
  onStart,
  onStop,
  onToggleSidebar,
  onTheme,
  phase,
  recording,
  selectedDevice,
  session,
  sidebarCollapsed,
  theme,
}: {
  readonly bitrateMbps: number;
  readonly fps: number;
  readonly onCapture: () => void;
  readonly onReconfigure: (bitrateMbps: number, fps: number) => void;
  readonly onRecord: () => void;
  readonly onRotate: (delta: number) => void;
  readonly onSessionActions: () => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onToggleSidebar: () => void;
  readonly onTheme: () => void;
  readonly phase: SessionState["phase"];
  readonly recording: boolean;
  readonly selectedDevice: DeviceDescriptor | undefined;
  readonly session: SessionRecord | undefined;
  readonly sidebarCollapsed: boolean;
  readonly theme: ThemePreference;
}): React.ReactElement {
  const canStart = selectedDevice?.authorizationState === "authorized" && phase !== "starting";
  return (
    <header className="topbar">
      <Button
        aria-expanded={!sidebarCollapsed}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="sidebar-toggle"
        onClick={onToggleSidebar}
        size="icon"
        title="Toggle sidebar"
        variant="ghost"
      >
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
          <Play aria-hidden="true" data-icon="inline-start" />
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
      <Button aria-label="More actions" onClick={onSessionActions} size="icon" variant="ghost">
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
  onOpenAdbScan,
  onRename,
  onSelect,
  onShowDeviceLog,
  onStartSession,
  sessionActive,
  selectedSerial,
}: {
  readonly accessPanel: React.ReactNode;
  readonly devices: readonly DeviceDescriptor[];
  readonly loading: boolean;
  readonly onConnectEndpoint: () => void;
  readonly onDisconnect: (serial: string) => Promise<void>;
  readonly onOpenAdbScan: () => void;
  readonly onRename: (device: DeviceDescriptor) => void;
  readonly onSelect: (serial: string) => void;
  readonly onShowDeviceLog: (device: DeviceDescriptor) => void;
  readonly onStartSession: (device: DeviceDescriptor) => void;
  readonly sessionActive: boolean;
  readonly selectedSerial: string | undefined;
}): React.ReactElement {
  const [openSerial, setOpenSerial] = React.useState<string | undefined>();
  return (
    <aside aria-label="Device and access controls" className="sidebar">
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
                <div className="device-menu" hidden={openSerial !== device.serial} role="menu">
                  <button
                    disabled={sessionActive}
                    onClick={() => {
                      onStartSession(device);
                      setOpenSerial(undefined);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Start session
                  </button>
                  <button
                    onClick={() => {
                      onShowDeviceLog(device);
                      setOpenSerial(undefined);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Show device log
                  </button>
                  <button
                    onClick={() => {
                      onRename(device);
                      setOpenSerial(undefined);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Rename device
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      setOpenSerial(undefined);
                      void onDisconnect(device.serial);
                    }}
                    role="menuitem"
                    type="button"
                  >
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
        <Button onClick={onOpenAdbScan} variant="outline">
          <List aria-hidden="true" data-icon="inline-start" />
          Scan adb devices
        </Button>
        <Button onClick={onConnectEndpoint} variant="secondary">
          <Wifi aria-hidden="true" data-icon="inline-start" />
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
  onClipboardToggle,
  port,
}: {
  readonly clipboardEnabled: boolean;
  readonly host: string;
  readonly onBind: () => void;
  readonly onClipboardToggle: () => void;
  readonly port: number;
}): React.ReactElement {
  const clipboardTitle = `Clipboard sync ${clipboardEnabled ? "enabled" : "disabled"}`;
  return (
    <section className="access-panel">
      <h2>ACCESS</h2>
      <button aria-label="Bind" className="access-row access-action" onClick={onBind} type="button">
        <span>
          <Settings2 aria-hidden="true" data-icon="inline-start" />
          Bind
        </span>
        <strong>{host}</strong>
        <span aria-hidden="true">&gt;</span>
      </button>
      <span className="compat-text">
        Bind {host}:{port}
      </span>
      <span className="compat-text">Bind {host}</span>
      <button
        aria-label="Toggle clipboard sync"
        aria-pressed={clipboardEnabled}
        className="access-row access-action"
        onClick={onClipboardToggle}
        title={clipboardTitle}
        type="button"
      >
        <span>
          <Clipboard aria-hidden="true" data-icon="inline-start" />
          Clipboard
        </span>
        <span className={cn("switch-pill", clipboardEnabled && "on")} title={clipboardTitle}>
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
  const landscape = isLandscapeRotation(rotation);
  return (
    <section aria-label="Android screen viewport" className="stage">
      <div
        className={cn(
          "phone-shell",
          landscape && "is-landscape",
          rotation === 180 && "rotation-180",
        )}
      >
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
    ["Overview", "overview", Circle],
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
  onResizeStart,
  resizing,
}: {
  readonly autoscroll: boolean;
  readonly level: LogLevel;
  readonly logs: readonly string[];
  readonly onAutoscrollChange: (enabled: boolean) => void;
  readonly onClear: () => void;
  readonly onLevelChange: (level: LogLevel) => void;
  readonly onResizeStart: (clientY: number) => void;
  readonly resizing: boolean;
}): React.ReactElement {
  const [resizerHovered, setResizerHovered] = React.useState(false);
  const visibleLogs = logs.filter((log) => isVisibleLogLine(log, level));
  return (
    <section aria-label="Log drawer" className={cn("log-drawer", resizing && "resizing")}>
      <div
        aria-label="Resize agent log"
        aria-orientation="horizontal"
        className={cn("drawer-resizer", resizerHovered && "hovered")}
        onMouseEnter={() => setResizerHovered(true)}
        onMouseLeave={() => setResizerHovered(false)}
        onMouseDown={(event) => {
          event.preventDefault();
          onResizeStart(event.clientY);
        }}
        onPointerEnter={() => setResizerHovered(true)}
        onPointerLeave={() => setResizerHovered(false)}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          onResizeStart(event.clientY);
        }}
        role="separator"
      />
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
          <Trash2 aria-hidden="true" data-icon="inline-start" />
          Clear
        </Button>
      </div>
      <div className="log-lines">
        {visibleLogs.length === 0 ? (
          <p>No logs</p>
        ) : (
          visibleLogs.map((log, index) => <LogLine key={`${log}-${index}`} value={log} />)
        )}
      </div>
    </section>
  );
}

function LogLine({ value }: { readonly value: string }): React.ReactElement {
  const parsed = parseLogLine(value);
  if (!parsed) {
    return <p className="log-line-plain">{value}</p>;
  }
  return (
    <p className="log-line-structured">
      <span>{parsed.time}</span>
      <span className={cn("log-level", `log-${parsed.level.toLowerCase()}`)}>{parsed.level}</span>
      <span>{parsed.area}</span>
      <span>{parsed.message}</span>
    </p>
  );
}

function Dialog({
  bindHost,
  bindPort,
  clipboardEnabled,
  devices,
  kind,
  onCancel,
  onBindHostChange,
  onBindPortChange,
  onCopyShareUrl,
  onRefreshDevices,
  onSelectAdbDevice,
  onSubmit,
  onValueChange,
  selectedAdbSerial,
  shareUrl,
  value,
}: {
  readonly bindHost: string;
  readonly bindPort: string;
  readonly clipboardEnabled: boolean;
  readonly devices: readonly DeviceDescriptor[];
  readonly kind: Exclude<DialogKind, undefined>;
  readonly onCancel: () => void;
  readonly onBindHostChange: (value: string) => void;
  readonly onBindPortChange: (value: string) => void;
  readonly onCopyShareUrl: () => void;
  readonly onRefreshDevices: () => void;
  readonly onSelectAdbDevice: (serial: string) => void;
  readonly onSubmit: () => void;
  readonly onValueChange: (value: string) => void;
  readonly selectedAdbSerial: string | undefined;
  readonly shareUrl: string;
  readonly value: string;
}): React.ReactElement {
  const title =
    kind === "endpoint"
      ? "Connect by endpoint"
      : kind === "rename"
        ? "Rename device"
        : kind === "bind"
          ? "Bind access"
          : kind === "power"
            ? "Power action"
            : kind === "session-actions"
              ? "Session actions"
              : "Scan adb devices";
  return (
    <div
      aria-label={title}
      aria-labelledby="dialog-title"
      className="dialog-backdrop"
      role="dialog"
    >
      <div className="dialog">
        <div className="dialog-head">
          <h2 id="dialog-title">{title}</h2>
        </div>
        <div className="dialog-body">
          {kind === "bind" ? (
            <>
              <label className="field">
                Bind address
                <select
                  aria-label="Bind address"
                  onChange={(event) => onBindHostChange(event.target.value)}
                  value={bindHost}
                >
                  <option value="127.0.0.1">127.0.0.1</option>
                  <option value="0.0.0.0">0.0.0.0</option>
                  <option value="192.168.1.20">192.168.1.20</option>
                </select>
              </label>
              <label className="field">
                Port
                <input
                  aria-label="Port"
                  onChange={(event) => onBindPortChange(event.target.value)}
                  type="number"
                  value={bindPort}
                />
              </label>
              <p className="status-note">
                Non-local bind addresses allow any client that can reach this PC address to connect.
                Authentication is required.
              </p>
              <label className="field">
                Share URL
                <input aria-label="Share URL" readOnly value={shareUrl} />
              </label>
            </>
          ) : null}
          {kind === "endpoint" || kind === "rename" ? (
            <>
              <label className="field">
                {kind === "endpoint" ? "ADB endpoint" : "Display name"}
                <input
                  autoFocus
                  onChange={(event) => onValueChange(event.target.value)}
                  placeholder={kind === "endpoint" ? "192.168.1.40:5555" : "Value"}
                  value={value}
                />
              </label>
              {kind === "endpoint" ? (
                <p>Use this when the device is not already visible in adb devices.</p>
              ) : null}
            </>
          ) : null}
          {kind === "power" ? (
            <p>
              Send a power-key event to the selected Android device. This is a guarded system
              action.
            </p>
          ) : null}
          {kind === "session-actions" ? (
            <label className="field">
              Reconnect policy
              <select aria-label="Reconnect policy" defaultValue="auto">
                <option value="auto">Auto reconnect</option>
                <option value="manual">Manual reconnect</option>
              </select>
            </label>
          ) : null}
          {kind === "adb-scan" ? (
            <>
              <p>
                Detected devices from adb devices -l. USB devices, running emulators, and already
                connected network devices appear in the same list.
              </p>
              <div className="adb-device-list">
                {devices.map((device) => (
                  <button
                    className={cn(
                      "adb-device-row",
                      selectedAdbSerial === device.serial && "selected",
                    )}
                    key={device.serial}
                    onClick={() => onSelectAdbDevice(device.serial)}
                    type="button"
                  >
                    <span>
                      <span className="adb-device-name">{device.model ?? "Android device"}</span>
                      <span className="adb-device-serial">{device.serial}</span>
                    </span>
                    <span className="adb-device-meta">
                      <span>{device.authorizationState}</span>
                      <span>{device.transportKind ?? "adb"}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {!clipboardEnabled && kind === "session-actions" ? (
            <p className="status-note">Clipboard sync is currently disabled.</p>
          ) : null}
        </div>
        <div className="dialog-actions">
          {kind === "session-actions" ? (
            <>
              <Button onClick={onCancel} variant="outline">
                Close
              </Button>
              <Button onClick={onSubmit}>Apply</Button>
            </>
          ) : null}
          {kind === "power" ? (
            <>
              <Button onClick={onCancel} variant="outline">
                Cancel
              </Button>
              <Button onClick={onSubmit} variant="outline">
                Send power
              </Button>
            </>
          ) : null}
          {kind === "bind" ? (
            <>
              <Button onClick={onCancel} variant="outline">
                Cancel
              </Button>
              <Button onClick={onCopyShareUrl} variant="outline">
                Copy share URL
              </Button>
              <Button onClick={onSubmit}>Save bind</Button>
            </>
          ) : null}
          {kind === "adb-scan" ? (
            <>
              <Button onClick={onCancel} variant="outline">
                Close
              </Button>
              <Button onClick={onRefreshDevices} variant="outline">
                Refresh
              </Button>
              <Button disabled={!selectedAdbSerial} onClick={onSubmit}>
                Connect selected
              </Button>
            </>
          ) : null}
          {kind === "endpoint" || kind === "rename" ? (
            <>
              <Button onClick={onCancel} variant="outline">
                Cancel
              </Button>
              <Button onClick={onSubmit}>{kind === "endpoint" ? "Connect" : "Save"}</Button>
            </>
          ) : null}
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

function createShareUrl(bindHost: string, port: number): string {
  const nextPort = Number.isFinite(port) && port > 0 ? port : fallbackRuntimeConfig.port;
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    return `http://127.0.0.1:${nextPort}`;
  }
  const host = bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost;
  return `http://${host}:${nextPort}`;
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

function isLandscapeRotation(rotation: number): boolean {
  const normalized = normalizeRotation(rotation);
  return normalized === 90 || normalized === 270;
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

function parseLogLine(value: string):
  | {
      readonly area: string;
      readonly level: "DEBUG" | "ERROR" | "INFO" | "WARN";
      readonly message: string;
      readonly time: string;
    }
  | undefined {
  const match =
    /^(?<time>\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\s+(?<level>DEBUG|ERROR|INFO|WARN)\s+(?<rest>.*)$/.exec(
      value,
    );
  const groups = match?.groups;
  if (!groups) {
    return undefined;
  }
  const { level, rest: rawRest, time } = groups;
  if (
    !time ||
    !rawRest ||
    (level !== "DEBUG" && level !== "ERROR" && level !== "INFO" && level !== "WARN")
  ) {
    return undefined;
  }
  const rest = rawRest.trimStart();
  const [area = "", ...messageParts] = rest.split(/\s+/);
  return {
    area,
    level,
    message: messageParts.join(" "),
    time,
  };
}

function isVisibleLogLine(value: string, level: LogLevel): boolean {
  if (level === "all") {
    return true;
  }
  const parsed = parseLogLine(value);
  return parsed ? parsed.level.toLowerCase() === level : value.toLowerCase().startsWith(level);
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
  if (!snapshot.configured) {
    return { detail: "Waiting for Android video configuration", title: "Viewport fit active" };
  }
  return { detail: "Receiving Android video", title: "Video ready" };
}
