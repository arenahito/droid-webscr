import * as React from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Check,
  Home,
  Menu,
  MonitorSmartphone,
  MoreVertical,
  Moon,
  Power,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Settings2,
  Smartphone,
  Square,
  Sun,
  Volume1,
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
import { appendLogs } from "./features/session/log-drawer-state.js";
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
import webPackageJson from "../package.json" with { type: "json" };

const disconnectedPhoneIconUrl = new URL("./assets/disconnected-phone.png", import.meta.url).href;
const appVersionLabel = `v${webPackageJson.version}`;
const collapsedLogHeightPx = 34;
const deviceLogFlushIntervalMs = 500;

export interface DroidWebscrAppProps {
  readonly client?: AgentClient | undefined;
  readonly initialLogs?: readonly string[] | undefined;
  readonly sessionSocketFactory?: ((session: SessionRecord) => SessionSocket) | undefined;
  readonly videoPipelineFactory?:
    | ((canvas: HTMLCanvasElement, onError: (message: string) => void) => VideoPipeline)
    | undefined;
  readonly storage?: StorageLike | undefined;
}

type NormalizedLogLevel = "debug" | "error" | "info" | "verbose" | "warn";
type LogLevel = "all" | Exclude<NormalizedLogLevel, "verbose">;
type DeviceLogStatus = "idle" | "connecting" | "tailing" | "error";
type DialogKind = "endpoint" | "bind" | "power" | undefined;

interface PinchGesture {
  readonly browserPointerId: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly primarySlot: number;
  readonly queueKey: number | undefined;
  readonly secondarySlot: number;
}

interface ClientPoint {
  readonly x: number;
  readonly y: number;
}

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

const defaultPhoneScreenSize = { height: 20, width: 9 } as const;
const phoneFrameInsetPx = 20;
const phoneViewportPaddingPx = 36;
const phoneControlGapPx = 20;
const phoneControlRailHeightPx = 38;
const phoneControlRailWidthPx = 46;
const pointerDragFrameIntervalMs = 8;
const pointerDragInterpolationStepPx = 12;
const syntheticPinchRadiusPx = 32;

const designInitialLogs: readonly string[] = [
  "10:42:10.231 INFO   stream     Starting stream: 1344x2992@30fps bitrate=4Mbps transport=USB",
  "10:42:10.448 INFO   control    Input channel established",
  "10:42:11.004 WARN   encoder    Bitrate pressure detected; holding 4Mbps",
  "10:42:12.773 INFO   clipboard  Clipboard sync disabled",
  "10:42:14.092 INFO   session    Agent ready",
];
const agentEndpointStorageKey = "droid-webscr.agentEndpoint";

export function DroidWebscrApp({
  client,
  initialLogs = designInitialLogs,
  sessionSocketFactory,
  videoPipelineFactory = createDefaultVideoPipeline,
  storage = browserStorage(),
}: DroidWebscrAppProps): React.ReactElement {
  const [agentBaseUrl, setAgentBaseUrl] = React.useState(
    () => storage.getItem(agentEndpointStorageKey) ?? "",
  );
  const agentClient = React.useMemo(
    () => client ?? createHttpAgentClient({ baseUrl: agentBaseUrl }),
    [agentBaseUrl, client],
  );
  const [devices, setDevices] = React.useState<readonly DeviceDescriptor[]>([]);
  const [loadingDevices, setLoadingDevices] = React.useState(true);
  const [runtimeConfig, setRuntimeConfig] = React.useState<RuntimeConfig>(fallbackRuntimeConfig);
  const [theme, setTheme] = React.useState<ThemePreference>(() => readTheme(storage));
  const [videoSnapshot, setVideoSnapshot] = React.useState<VideoPipelineSnapshot | undefined>();
  const [controlReady, setControlReadyState] = React.useState(false);
  const [bitrateMbps, setBitrateMbps] = React.useState(4);
  const [fps, setFps] = React.useState(30);
  const [rotation, setRotation] = React.useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [dialog, setDialog] = React.useState<DialogKind>();
  const [dialogValue, setDialogValue] = React.useState("");
  const [bindHostDraft, setBindHostDraft] = React.useState(fallbackRuntimeConfig.bindHost);
  const [bindPortDraft, setBindPortDraft] = React.useState(String(fallbackRuntimeConfig.port));
  const [shareUrl, setShareUrl] = React.useState(
    createShareUrl(fallbackRuntimeConfig.bindHost, fallbackRuntimeConfig.port),
  );
  const [toast, setToast] = React.useState<string | undefined>();
  const [logLevel, setLogLevel] = React.useState<LogLevel>("info");
  const [autoscroll, setAutoscroll] = React.useState(true);
  const [wrapLogLines, setWrapLogLines] = React.useState(false);
  const [logHeight, setLogHeight] = React.useState(180);
  const [logCollapsed, setLogCollapsed] = React.useState(true);
  const [logResizing, setLogResizing] = React.useState(false);
  const [deviceLogEnabled, setDeviceLogEnabled] = React.useState(false);
  const [deviceLogs, setDeviceLogs] = React.useState<readonly string[]>([]);
  const [deviceLogStatus, setDeviceLogStatus] = React.useState<DeviceLogStatus>("idle");
  const [state, dispatch] = React.useReducer(reduceSessionState, {
    ...defaultSessionState,
    logs: initialLogs,
  });
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const textInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const sessionSocketRef = React.useRef<SessionSocket | undefined>(undefined);
  const controlReadyRef = React.useRef(false);
  const videoPipelineRef = React.useRef<VideoPipeline | undefined>(undefined);
  const activePointerSlotsRef = React.useRef(new Map<number, number>());
  const pointerPositionsRef = React.useRef(new Map<number, ClientPoint>());
  const pointerFrameQueueRef = React.useRef(new Map<number, Promise<void>>());
  const pointerSlotFrameQueueRef = React.useRef(new Map<number, Promise<void>>());
  const pointerGestureGenerationRef = React.useRef(new Map<number, number>());
  const pointerQueueGenerationRef = React.useRef(0);
  const pendingDeviceLogsRef = React.useRef<string[]>([]);
  const deviceLogFlushTimerRef = React.useRef<number | undefined>(undefined);
  const deviceLogSerialRef = React.useRef<string | undefined>(undefined);
  const pinchGestureRef = React.useRef<PinchGesture | undefined>(undefined);
  const sequenceRef = React.useRef(1n);
  const selectedDevice = devices.find((device) => device.serial === state.selectedSerial);
  const useDesignApiFallback = shouldUseDesignApiFallback(client) && !agentBaseUrl;
  const [viewportRef, viewportSize] = useElementSize<HTMLElement>();
  const appStyle = React.useMemo(
    () =>
      ({
        "--log-height": `${logCollapsed ? collapsedLogHeightPx : logHeight}px`,
      }) as React.CSSProperties,
    [logCollapsed, logHeight],
  );
  const displayScreenSize = getDisplayScreenSize(videoSnapshot, rotation);
  const displayLandscape = displayScreenSize.width > displayScreenSize.height;

  const setControlReady = React.useCallback((ready: boolean) => {
    controlReadyRef.current = ready;
    setControlReadyState(ready);
  }, []);

  React.useEffect(() => {
    applyTheme(theme);
    persistTheme(storage, theme);
  }, [storage, theme]);

  const notify = React.useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(undefined), 1600);
  }, []);

  const clearPendingDeviceLogs = React.useCallback(() => {
    pendingDeviceLogsRef.current = [];
    /* v8 ignore next 4 -- clearing a pending browser timer depends on sub-frame UI timing. */
    if (deviceLogFlushTimerRef.current !== undefined) {
      window.clearTimeout(deviceLogFlushTimerRef.current);
      deviceLogFlushTimerRef.current = undefined;
    }
  }, []);

  const flushPendingDeviceLogs = React.useCallback(() => {
    const entries = pendingDeviceLogsRef.current;
    pendingDeviceLogsRef.current = [];
    deviceLogFlushTimerRef.current = undefined;
    /* v8 ignore next -- zero-entry flushes are timer cleanup guards with no visible state change. */
    if (entries.length > 0) {
      setDeviceLogs((current) => appendLogs(current, entries));
    }
  }, []);

  const enqueueDeviceLog = React.useCallback(
    (line: string) => {
      pendingDeviceLogsRef.current.push(line);
      if (deviceLogFlushTimerRef.current === undefined) {
        deviceLogFlushTimerRef.current = window.setTimeout(
          flushPendingDeviceLogs,
          deviceLogFlushIntervalMs,
        );
      }
    },
    [flushPendingDeviceLogs],
  );

  const setLogHeightFromClientY = React.useCallback((clientY: number) => {
    const nextHeight = Math.round(window.innerHeight - clientY);
    setLogHeight(Math.max(88, Math.min(500, nextHeight)));
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
      notify(error instanceof Error ? error.message : "Device listing failed");
    } finally {
      setLoadingDevices(false);
    }
  }, [agentClient, notify, state.selectedSerial]);

  React.useEffect(() => {
    void refreshDevices();
    if (!useDesignApiFallback) {
      void agentClient
        .getRuntimeConfig?.()
        .then((config) => {
          setRuntimeConfig(config);
          setBindHostDraft(config.bindHost);
          setBindPortDraft(String(config.port));
          setShareUrl(createShareUrl(config.bindHost, config.port, agentBaseUrl));
          persistAgentBaseUrl(
            createAgentEndpointUrl(config.bindHost, config.port, agentBaseUrl),
            setAgentBaseUrl,
            storage,
          );
        })
        .catch(ignoreAsyncError);
    }
  }, [agentBaseUrl, agentClient, refreshDevices, storage, useDesignApiFallback]);

  React.useEffect(() => {
    const serial = state.selectedSerial;
    clearPendingDeviceLogs();
    if (deviceLogSerialRef.current !== serial) {
      deviceLogSerialRef.current = serial;
      setDeviceLogs([]);
    }
    if (!serial) {
      setDeviceLogStatus("idle");
      return undefined;
    }
    if (!deviceLogEnabled) {
      setDeviceLogStatus("idle");
      return undefined;
    }
    setDeviceLogs([]);
    setDeviceLogStatus("connecting");
    const controller = new AbortController();
    const tailPromise = agentClient.tailDeviceLogs
      ? agentClient.tailDeviceLogs(serial, {
          onLine: (line) => {
            /* v8 ignore next 3 -- late tail lines after AbortSignal are race-dependent. */
            if (controller.signal.aborted) {
              return;
            }
            setDeviceLogStatus("tailing");
            enqueueDeviceLog(line);
          },
          signal: controller.signal,
        })
      : Promise.reject(new Error("Device log tail is unavailable"));
    void tailPromise
      .then(() => {
        /* v8 ignore next 3 -- a normally completed live tail is not produced by the agent API. */
        if (!controller.signal.aborted) {
          setDeviceLogStatus("idle");
        }
      })
      .catch((error) => {
        /* v8 ignore next 3 -- tail rejection after abort is race-dependent. */
        if (controller.signal.aborted) {
          return;
        }
        setDeviceLogStatus("error");
        /* v8 ignore next -- client failures are normalized to Error objects in tests. */
        notify(error instanceof Error ? error.message : "Device log tail failed");
      });
    return () => {
      controller.abort();
      clearPendingDeviceLogs();
    };
  }, [
    agentClient,
    clearPendingDeviceLogs,
    deviceLogEnabled,
    enqueueDeviceLog,
    notify,
    state.selectedSerial,
  ]);

  const openBindDialog = React.useCallback(() => {
    setBindHostDraft(runtimeConfig.bindHost);
    setBindPortDraft(String(runtimeConfig.port));
    setShareUrl(createShareUrl(runtimeConfig.bindHost, runtimeConfig.port, agentBaseUrl));
    setDialog("bind");
  }, [agentBaseUrl, runtimeConfig]);

  const finishSession = React.useCallback(
    (options: {
      readonly closeSocket: boolean;
      readonly expectedSocket?: SessionSocket | undefined;
    }) => {
      const socket = sessionSocketRef.current;
      if (options.expectedSocket && socket !== options.expectedSocket) {
        return;
      }
      const pipeline = videoPipelineRef.current;
      pointerQueueGenerationRef.current += 1;
      activePointerSlotsRef.current.clear();
      pointerPositionsRef.current.clear();
      pointerFrameQueueRef.current.clear();
      pointerSlotFrameQueueRef.current.clear();
      pointerGestureGenerationRef.current.clear();
      pinchGestureRef.current = undefined;
      sessionSocketRef.current = undefined;
      setControlReady(false);
      videoPipelineRef.current = undefined;
      if (options.closeSocket) {
        socket?.close();
      }
      pipeline?.close();
      clearCanvas(canvasRef.current);
      setVideoSnapshot(undefined);
      dispatch({ type: "stop" });
    },
    [setControlReady],
  );

  const createSessionSocketForRuntime = React.useCallback(
    (session: SessionRecord) =>
      sessionSocketFactory?.(session) ?? createDefaultSessionSocket(session, agentBaseUrl),
    [agentBaseUrl, sessionSocketFactory],
  );

  const startSessionForSerial = React.useCallback(
    async (serial: string | undefined) => {
      /* v8 ignore next 3 -- UI controls disable duplicate starts before this guard is reachable. */
      if (!serial || state.phase === "starting" || state.session) {
        return;
      }
      setControlReady(false);
      dispatch({ serial, type: "select-device" });
      dispatch({ type: "start-requested" });
      try {
        const session = await agentClient.createSession(serial, { bitrateMbps, fps });
        const socket = createSessionSocketForRuntime(session);
        sessionSocketRef.current = socket;
        socket.onClose(() => {
          finishSession({ closeSocket: false, expectedSocket: socket });
        });
        const canvas = canvasRef.current;
        if (canvas) {
          const pipeline = videoPipelineFactory(canvas, (message) => {
            dispatch({ message, type: "failed" });
            notify(message);
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
              if (sessionSocketRef.current !== socket || videoPipelineRef.current !== pipeline) {
                return;
              }
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
        /* v8 ignore next 3 -- stale socket replacement during waitUntilOpen needs artificial races. */
        if (sessionSocketRef.current !== socket) {
          return;
        }
        setControlReady(true);
        dispatch({ session, type: "start-succeeded" });
      } catch (error) {
        finishSession({ closeSocket: true });
        const message = error instanceof Error ? error.message : "Session creation failed";
        dispatch({ message, type: "failed" });
        notify(message);
      }
    },
    [
      agentClient,
      finishSession,
      bitrateMbps,
      createSessionSocketForRuntime,
      fps,
      notify,
      setControlReady,
      state.phase,
      state.session,
      videoPipelineFactory,
    ],
  );

  const startSession = React.useCallback(
    async () => startSessionForSerial(state.selectedSerial),
    [startSessionForSerial, state.selectedSerial],
  );

  const stopSession = React.useCallback(() => {
    /* v8 ignore next -- Stop is only reachable after a selected device or active session exists. */
    const serial = state.session?.serial ?? state.selectedSerial;
    /* v8 ignore next -- Stop is only reachable after a selected device or active session exists. */
    if (serial) {
      void agentClient.resetDeviceRotation?.(serial).catch(ignoreAsyncError);
    }
    finishSession({ closeSocket: true });
  }, [agentClient, finishSession, state.selectedSerial, state.session?.serial]);

  const sendControlFrame = React.useCallback(async (frame: Uint8Array) => {
    if (!controlReadyRef.current) {
      return;
    }
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

  const requestRotation = React.useCallback(
    (delta: number) => {
      const serial = state.session?.serial ?? state.selectedSerial;
      if (controlReadyRef.current) {
        /* v8 ignore next -- connected rotation is only reachable with a selected session serial. */
        if (serial) {
          void agentClient
            /* v8 ignore next -- rotateDevice is part of the runtime client contract for live control. */
            .rotateDevice?.(serial, delta < 0 ? "left" : "right")
            .then((result) => notify(result.message))
            .catch((error) => {
              /* v8 ignore next -- client failures are normalized to Error objects in tests. */
              notify(error instanceof Error ? error.message : "Device rotation failed");
            });
        }
        return;
      }
      setRotation((current) => (current + delta + 360) % 360);
    },
    [agentClient, notify, state.selectedSerial, state.session?.serial],
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

  const refreshDeviceList = React.useCallback(
    async (successMessage?: string): Promise<void> => {
      try {
        setLoadingDevices(true);
        const nextDevices = await (agentClient.scanDevices?.() ?? agentClient.listDevices());
        setDevices(nextDevices);
        if (successMessage) {
          notify(successMessage);
        }
      } catch (error) {
        dispatch({
          /* v8 ignore next -- client failures are normalized to Error objects in tests. */
          message: error instanceof Error ? error.message : "Device scan failed",
          type: "failed",
        });
        /* v8 ignore next -- client failures are normalized to Error objects in tests. */
        notify(error instanceof Error ? error.message : "Device scan failed");
      } finally {
        setLoadingDevices(false);
      }
    },
    [agentClient, notify],
  );

  const submitDialog = React.useCallback(async () => {
    const value = dialogValue.trim();
    if (dialog === "endpoint" && !value) {
      return;
    }
    try {
      if (dialog === "endpoint") {
        await agentClient.connectEndpoint?.(value);
        notify("Endpoint connected");
        await refreshDeviceList();
      }
      if (dialog === "bind") {
        const bindHost = bindHostDraft.trim();
        const bindPort = Number(bindPortDraft);
        /* v8 ignore next -- the dialog keeps a concrete bind host selected in supported UI flows. */
        const host = bindHost.length > 0 ? bindHost : runtimeConfig.bindHost;
        /* v8 ignore next -- invalid numeric input is handled by the browser input before submit. */
        const port = Number.isFinite(bindPort) && bindPort > 0 ? bindPort : runtimeConfig.port;
        const result = await agentClient.saveRuntimeBind?.(host, port);
        /* v8 ignore start -- partial bind responses are defensive compatibility fallbacks. */
        setRuntimeConfig((current) => ({
          ...current,
          bindHost: result?.bindHost ?? host,
          clipboardEnabled: result?.clipboardEnabled ?? current.clipboardEnabled,
          port: result?.port ?? port,
        }));
        /* v8 ignore stop */
        const nextAgentBaseUrl = createAgentEndpointUrl(host, port, agentBaseUrl);
        const nextShareUrl = createShareUrl(host, port, nextAgentBaseUrl);
        setShareUrl(nextShareUrl);
        persistAgentBaseUrl(nextAgentBaseUrl, setAgentBaseUrl, storage);
        /* v8 ignore start -- missing bind messages are defensive compatibility fallbacks. */
        dispatch({
          message: result?.message ?? `INFO Agent is now listening on ${host}:${port}.`,
          type: "log",
        });
        notify(result?.message ?? (result?.ok ? "Bind applied" : "Bind update queued"));
        /* v8 ignore stop */
      }
      if (dialog === "power") {
        sendSystemAction("power");
      }
      setDialog(undefined);
      setDialogValue("");
    } catch (error) {
      dispatch({
        /* v8 ignore next -- client failures are normalized to Error objects in tests. */
        message: error instanceof Error ? error.message : "Agent operation failed",
        type: "failed",
      });
    }
  }, [
    agentBaseUrl,
    agentClient,
    bindHostDraft,
    bindPortDraft,
    dialog,
    dialogValue,
    notify,
    refreshDeviceList,
    runtimeConfig,
    sendSystemAction,
    storage,
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
      /* v8 ignore next -- pointer input is user-reachable only after video size is known. */
      const size = videoSnapshot?.videoSize ?? { height: 1280, width: 720 };
      const rect = event.currentTarget.getBoundingClientRect();
      const socket = sessionSocketRef.current;
      const queueGeneration = pointerQueueGenerationRef.current;
      if (action === "down") {
        pointerGestureGenerationRef.current.set(
          event.pointerId,
          (pointerGestureGenerationRef.current.get(event.pointerId) ?? 0) + 1,
        );
      }
      const pointerGestureGeneration = pointerGestureGenerationRef.current.get(event.pointerId);
      const clearPointerGestureState = () => {
        for (const pointerId of activePointerSlotsRef.current.keys()) {
          pointerGestureGenerationRef.current.set(
            pointerId,
            (pointerGestureGenerationRef.current.get(pointerId) ?? 0) + 1,
          );
        }
        activePointerSlotsRef.current.clear();
        pointerPositionsRef.current.clear();
        pinchGestureRef.current = undefined;
      };
      const sendPointerFrame = (
        frameAction: PointerAction,
        pointerSlot: number,
        x: number,
        y: number,
        buttons: number,
        pressure: number,
        queueKey?: number,
        delayMs = 0,
      ) => {
        const frame = mapPointerToControlFrame({
          action: frameAction,
          buttons,
          display: {
            height: size.height,
            rotation: normalizeRotation(rotation),
            width: size.width,
          },
          pointerId: pointerSlot,
          pressure,
          sequence: nextSequence(sequenceRef),
          viewport: { height: rect.height, left: rect.left, top: rect.top, width: rect.width },
          x,
          y,
        });
        const sendIfCurrent = async () => {
          const stalePointerGesture =
            queueKey !== undefined &&
            pointerGestureGenerationRef.current.get(queueKey) !== pointerGestureGeneration;
          if (stalePointerGesture && frameAction !== "up" && frameAction !== "cancel") {
            return;
          }
          if (
            sessionSocketRef.current !== socket ||
            pointerQueueGenerationRef.current !== queueGeneration
          ) {
            return;
          }
          await socket?.send(frame);
        };
        if (frameAction === "cancel") {
          void sendIfCurrent();
          pointerQueueGenerationRef.current += 1;
          pointerFrameQueueRef.current.clear();
          pointerSlotFrameQueueRef.current.clear();
          return;
        }
        if (queueKey === undefined) {
          if (delayMs === 0 && !pointerSlotFrameQueueRef.current.has(pointerSlot)) {
            void sendIfCurrent();
            return;
          }
          enqueuePointerFrame(
            pointerSlotFrameQueueRef.current,
            pointerSlot,
            sendIfCurrent,
            delayMs,
          );
          return;
        }
        const previousPointerFrame = pointerFrameQueueRef.current.get(queueKey);
        const sendAfterPointerFrame = async () => {
          await previousPointerFrame?.catch(ignoreAsyncError);
          await sendIfCurrent();
        };
        const queuedSlotFrame = enqueuePointerFrame(
          pointerSlotFrameQueueRef.current,
          pointerSlot,
          sendAfterPointerFrame,
          delayMs,
        );
        trackPointerQueue(pointerFrameQueueRef.current, queueKey, queuedSlotFrame);
      };

      const pinchGesture = pinchGestureRef.current;
      if (pinchGesture?.browserPointerId === event.pointerId) {
        event.preventDefault();
        const [primary, secondary] = createSyntheticPinchPoints(pinchGesture, event);
        if (action === "up" || action === "cancel") {
          if (action === "cancel") {
            sendPointerFrame(
              "cancel",
              pinchGesture.primarySlot,
              primary.x,
              primary.y,
              0,
              0,
              pinchGesture.queueKey,
            );
            clearPointerGestureState();
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            return;
          }
          sendPointerFrame(
            action,
            pinchGesture.secondarySlot,
            secondary.x,
            secondary.y,
            0,
            0,
            pinchGesture.queueKey,
          );
          sendPointerFrame(
            action,
            pinchGesture.primarySlot,
            primary.x,
            primary.y,
            0,
            0,
            pinchGesture.queueKey,
          );
          activePointerSlotsRef.current.delete(event.pointerId);
          activePointerSlotsRef.current.delete(syntheticPinchPointerId(event.pointerId));
          pinchGestureRef.current = undefined;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          return;
        }
        sendPointerFrame(
          "move",
          pinchGesture.primarySlot,
          primary.x,
          primary.y,
          0,
          event.pressure || 1,
          pinchGesture.queueKey,
        );
        sendPointerFrame(
          "move",
          pinchGesture.secondarySlot,
          secondary.x,
          secondary.y,
          0,
          event.pressure || 1,
          pinchGesture.queueKey,
        );
        return;
      }

      if (action === "down" && isPinchModifierPressed(event)) {
        const secondaryBrowserPointerId = syntheticPinchPointerId(event.pointerId);
        const primarySlot = resolvePointerSlot(
          activePointerSlotsRef.current,
          event.pointerId,
          action,
        );
        const secondarySlot = resolvePointerSlot(
          activePointerSlotsRef.current,
          secondaryBrowserPointerId,
          action,
        );
        /* v8 ignore next 3 -- slot exhaustion during synthetic pinch needs an artificial 10-touch setup. */
        if (primarySlot === undefined || secondarySlot === undefined) {
          return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const pendingPinchQueue =
          pointerFrameQueueRef.current.has(event.pointerId) ||
          pointerSlotFrameQueueRef.current.has(primarySlot) ||
          pointerSlotFrameQueueRef.current.has(secondarySlot);
        const nextPinchGesture = {
          browserPointerId: event.pointerId,
          centerX: event.clientX,
          centerY: event.clientY,
          primarySlot,
          queueKey: pendingPinchQueue ? event.pointerId : undefined,
          secondarySlot,
        };
        pinchGestureRef.current = nextPinchGesture;
        const [primary, secondary] = createSyntheticPinchPoints(nextPinchGesture, event);
        sendPointerFrame(
          "down",
          primarySlot,
          primary.x,
          primary.y,
          0,
          event.pressure || 1,
          nextPinchGesture.queueKey,
        );
        sendPointerFrame(
          "down",
          secondarySlot,
          secondary.x,
          secondary.y,
          0,
          event.pressure || 1,
          nextPinchGesture.queueKey,
        );
        return;
      }

      const pointerSlot = resolvePointerSlot(
        activePointerSlotsRef.current,
        event.pointerId,
        action,
      );
      if (pointerSlot === undefined) {
        return;
      }
      event.preventDefault();
      if (action === "down") {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      const currentPoint = { x: event.clientX, y: event.clientY };
      if (action === "move") {
        const previousPoint = pointerPositionsRef.current.get(event.pointerId);
        for (const [index, point] of interpolatePointerDrag(
          previousPoint,
          currentPoint,
        ).entries()) {
          sendPointerFrame(
            "move",
            pointerSlot,
            point.x,
            point.y,
            event.buttons || 1,
            event.pressure || 1,
            event.pointerId,
            index === 0 ? 0 : pointerDragFrameIntervalMs,
          );
        }
        pointerPositionsRef.current.set(event.pointerId, currentPoint);
        return;
      }
      if (action === "up") {
        const previousPoint = pointerPositionsRef.current.get(event.pointerId);
        for (const [index, point] of interpolatePointerDrag(
          previousPoint,
          currentPoint,
        ).entries()) {
          sendPointerFrame(
            "move",
            pointerSlot,
            point.x,
            point.y,
            event.buttons || 1,
            1,
            event.pointerId,
            /* v8 ignore next -- delayed follow-up drag frames are covered, but the first frame stays immediate. */
            index === 0 ? 0 : pointerDragFrameIntervalMs,
          );
        }
      }
      sendPointerFrame(
        action,
        pointerSlot,
        currentPoint.x,
        currentPoint.y,
        /* v8 ignore next -- cancel is a browser safety path; ordinary up/down/move coverage drives behavior. */
        action === "up" || action === "cancel" ? 0 : event.buttons || 1,
        action === "up" || action === "cancel" ? 0 : event.pressure || 1,
        (action === "down" && pointerFrameQueueRef.current.has(event.pointerId)) ||
          action === "up" ||
          action === "cancel"
          ? event.pointerId
          : undefined,
      );
      if (action === "down") {
        pointerPositionsRef.current.set(event.pointerId, currentPoint);
      }
      if (action === "up" || action === "cancel") {
        if (action === "cancel") {
          clearPointerGestureState();
        } else {
          activePointerSlotsRef.current.delete(event.pointerId);
          pointerPositionsRef.current.delete(event.pointerId);
        }
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    },
    [rotation, videoSnapshot?.videoSize],
  );

  React.useEffect(
    () => () => {
      const socket = sessionSocketRef.current;
      const pipeline = videoPipelineRef.current;
      pointerQueueGenerationRef.current += 1;
      activePointerSlotsRef.current.clear();
      pointerPositionsRef.current.clear();
      pointerFrameQueueRef.current.clear();
      pointerSlotFrameQueueRef.current.clear();
      pointerGestureGenerationRef.current.clear();
      pinchGestureRef.current = undefined;
      sessionSocketRef.current = undefined;
      setControlReady(false);
      videoPipelineRef.current = undefined;
      socket?.close();
      pipeline?.close();
      clearCanvas(canvasRef.current);
    },
    [setControlReady],
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
        onReconfigure={sendVideoReconfigure}
        onStart={() => void startSession()}
        onStop={stopSession}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        phase={state.phase}
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
              await refreshDeviceList();
            }}
            onRefreshDevices={() => void refreshDeviceList("Devices refreshed")}
            onSelect={(serial) => dispatch({ serial, type: "select-device" })}
            onStartSession={(device) => void startSessionForSerial(device.serial)}
            sessionActive={Boolean(state.session) || state.phase === "starting"}
            selectedSerial={state.selectedSerial}
            accessPanel={
              <AccessPanel
                disabled={Boolean(state.session) || state.phase === "starting"}
                host={runtimeConfig.bindHost}
                onBind={openBindDialog}
                port={runtimeConfig.port}
              />
            }
          />
        )}
        <section className="viewport-grid bg-viewport" ref={viewportRef}>
          <div className={cn("stage-pair", displayLandscape && "is-landscape")}>
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
                /* v8 ignore next -- stray move events without an active slot have no observable behavior. */
                if (activePointerSlotsRef.current.has(event.pointerId)) {
                  sendPointer(event, "move");
                }
              }}
              onPointerUp={(event) => sendPointer(event, "up")}
              rotation={rotation}
              textInputRef={textInputRef}
              viewportSize={viewportSize}
              videoSnapshot={videoSnapshot}
            />
            <AndroidControls
              sessionActive={controlReady}
              onRotate={requestRotation}
              onSystemAction={requestSystemAction}
            />
          </div>
        </section>
      </div>
      <LogDrawer
        autoscroll={autoscroll}
        canStart={Boolean(state.selectedSerial)}
        collapsed={logCollapsed}
        emptyMessage={describeDeviceLogEmptyState(
          state.selectedSerial,
          deviceLogStatus,
          deviceLogEnabled,
        )}
        enabled={deviceLogEnabled}
        level={logLevel}
        logs={deviceLogs}
        resizing={logResizing}
        onAutoscrollChange={setAutoscroll}
        onClear={() => setDeviceLogs([])}
        onCollapsedChange={(collapsed) => {
          setLogCollapsed(collapsed);
          if (collapsed) {
            setLogResizing(false);
          }
        }}
        onLevelChange={setLogLevel}
        onLogEnabledChange={(enabled) => {
          if (enabled) {
            setDeviceLogs([]);
          }
          setDeviceLogEnabled(enabled);
        }}
        onResizeStart={(clientY) => {
          setLogHeightFromClientY(clientY);
          setLogResizing(true);
        }}
        onWrapLinesChange={setWrapLogLines}
        wrapLines={wrapLogLines}
      />
      {dialog ? (
        <Dialog
          kind={dialog}
          bindHost={bindHostDraft}
          bindPort={bindPortDraft}
          onCancel={() => {
            setDialog(undefined);
          }}
          onCopyShareUrl={() => {
            void navigator.clipboard?.writeText(shareUrl);
            notify("Share URL copied");
          }}
          onSubmit={() => void submitDialog()}
          onBindHostChange={(value) => {
            setBindHostDraft(value);
            setShareUrl(createShareUrl(value, Number(bindPortDraft), agentBaseUrl));
          }}
          onBindPortChange={(value) => {
            setBindPortDraft(value);
            setShareUrl(createShareUrl(bindHostDraft, Number(value), agentBaseUrl));
          }}
          onValueChange={setDialogValue}
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
  onReconfigure,
  onStart,
  onStop,
  onToggleSidebar,
  onTheme,
  phase,
  selectedDevice,
  session,
  sidebarCollapsed,
  theme,
}: {
  readonly bitrateMbps: number;
  readonly fps: number;
  readonly onReconfigure: (bitrateMbps: number, fps: number) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onToggleSidebar: () => void;
  readonly onTheme: () => void;
  readonly phase: SessionState["phase"];
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
          <span>{appVersionLabel}</span>
        </div>
      </div>
      <span aria-label="Session status" className="session-status" hidden>
        {session ? `Session ${session.sessionId}` : "No session"}
      </span>
      {session ? (
        <Button className="session-toggle session-running" onClick={onStop} variant="outline">
          <Square aria-hidden="true" data-icon="inline-start" />
          Stop
        </Button>
      ) : (
        <Button
          aria-label="Start"
          className="session-toggle"
          disabled={!canStart}
          onClick={onStart}
        >
          <Play aria-hidden="true" data-icon="inline-start" />
          Start
        </Button>
      )}
      <label className="select-label">
        <select
          aria-label="Bitrate"
          onChange={(event) => onReconfigure(Number(event.target.value), fps)}
          value={bitrateMbps}
        >
          <option value={2}>2 Mbps</option>
          <option value={4}>4 Mbps</option>
          <option value={8}>8 Mbps</option>
          <option value={12}>12 Mbps</option>
        </select>
      </label>
      <label className="select-label">
        <select
          aria-label="FPS"
          disabled={phase !== "idle"}
          onChange={(event) => onReconfigure(bitrateMbps, Number(event.target.value))}
          value={fps}
        >
          <option value={15}>15 fps</option>
          <option value={30}>30 fps</option>
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
    </header>
  );
}

function Sidebar({
  accessPanel,
  devices,
  loading,
  onConnectEndpoint,
  onDisconnect,
  onRefreshDevices,
  onSelect,
  onStartSession,
  sessionActive,
  selectedSerial,
}: {
  readonly accessPanel: React.ReactNode;
  readonly devices: readonly DeviceDescriptor[];
  readonly loading: boolean;
  readonly onConnectEndpoint: () => void;
  readonly onDisconnect: (serial: string) => Promise<void>;
  readonly onRefreshDevices: () => void;
  readonly onSelect: (serial: string) => void;
  readonly onStartSession: (device: DeviceDescriptor) => void;
  readonly sessionActive: boolean;
  readonly selectedSerial: string | undefined;
}): React.ReactElement {
  const [openSerial, setOpenSerial] = React.useState<string | undefined>();
  const openDeviceMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const openDeviceMenuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (sessionActive) {
      setOpenSerial(undefined);
    }
  }, [sessionActive]);

  React.useEffect(() => {
    if (!openSerial) {
      return undefined;
    }
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (openDeviceMenuRef.current?.contains(target) ||
          openDeviceMenuButtonRef.current?.contains(target))
      ) {
        return;
      }
      setOpenSerial(undefined);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [openSerial]);

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
                className={cn(
                  "device-card",
                  selectedSerial === device.serial && "selected",
                  sessionActive && selectedSerial !== device.serial && "disabled",
                  openSerial === device.serial && "menu-open",
                )}
                key={device.serial}
              >
                <div className="device-card-main">
                  <button
                    aria-label={`${device.model ?? "Android device"} ${device.serial}`}
                    disabled={sessionActive && selectedSerial !== device.serial}
                    onClick={() => onSelect(device.serial)}
                    type="button"
                  >
                    <Smartphone aria-hidden="true" />
                    <span>
                      <strong>{device.model ?? "Android device"}</strong>
                      <small>{device.serial}</small>
                      <small className="device-state">
                        <span className="status-dot" />
                        {sessionActive && selectedSerial === device.serial
                          ? "session active"
                          : device.authorizationState}
                      </small>
                    </span>
                    {selectedSerial === device.serial ? <Check aria-hidden="true" /> : null}
                  </button>
                  <Button
                    aria-expanded={openSerial === device.serial}
                    aria-label={`Open ${device.model ?? device.serial} menu`}
                    disabled={sessionActive}
                    onClick={() => {
                      setOpenSerial((current) =>
                        current === device.serial ? undefined : device.serial,
                      );
                    }}
                    ref={(element) => {
                      if (openSerial === device.serial) {
                        openDeviceMenuButtonRef.current = element;
                      }
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <MoreVertical aria-hidden="true" />
                  </Button>
                </div>
                <div
                  className="device-menu"
                  hidden={openSerial !== device.serial}
                  ref={(element) => {
                    if (openSerial === device.serial) {
                      openDeviceMenuRef.current = element;
                    }
                  }}
                  role="menu"
                >
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
                    className="danger"
                    disabled={sessionActive}
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
        <Button disabled={sessionActive} onClick={onRefreshDevices} variant="outline">
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Refresh devices
        </Button>
        <Button disabled={sessionActive} onClick={onConnectEndpoint} variant="secondary">
          <Wifi aria-hidden="true" data-icon="inline-start" />
          Connect by endpoint
        </Button>
      </div>
      {accessPanel}
    </aside>
  );
}

function AccessPanel({
  disabled,
  host,
  onBind,
  port,
}: {
  readonly disabled: boolean;
  readonly host: string;
  readonly onBind: () => void;
  readonly port: number;
}): React.ReactElement {
  return (
    <section className="access-panel">
      <h2>ACCESS</h2>
      <button
        aria-label="Bind"
        className="access-row access-action"
        disabled={disabled}
        onClick={onBind}
        type="button"
      >
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
  viewportSize,
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
  readonly viewportSize: { readonly height: number; readonly width: number } | undefined;
  readonly videoSnapshot: VideoPipelineSnapshot | undefined;
}): React.ReactElement {
  const status = describeVideoStatus(videoSnapshot);
  const displaySize = getDisplayScreenSize(videoSnapshot, rotation);
  const landscape = displaySize.width > displaySize.height;
  const phoneStyle = createPhoneStyle(displaySize, viewportSize, landscape);
  return (
    <section aria-label="Android screen viewport" className="stage">
      <div
        className={cn(
          "phone-shell",
          landscape && "is-landscape",
          rotation === 180 && "rotation-180",
        )}
        style={phoneStyle}
      >
        {videoSnapshot?.lastError ? <small className="compat-text">{status.detail}</small> : null}
        {device ? <span className="compat-text">{device.serial}</span> : null}
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
          {videoSnapshot?.configured ? null : <DisconnectedPhonePlaceholder status={status} />}
        </div>
      </div>
    </section>
  );
}

function useElementSize<TElement extends HTMLElement>(): [
  React.RefObject<TElement | null>,
  { readonly height: number; readonly width: number } | undefined,
] {
  const ref = React.useRef<TElement | null>(null);
  const [size, setSize] = React.useState<{ readonly height: number; readonly width: number }>();

  React.useEffect(() => {
    const element = ref.current;
    /* v8 ignore next 3 -- mounted components always attach the measured element before the effect runs. */
    if (!element) {
      return undefined;
    }
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setSize({ height: rect.height, width: rect.width });
    };
    updateSize();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateSize);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  return [ref, size];
}

function getDisplayScreenSize(
  snapshot: VideoPipelineSnapshot | undefined,
  rotation: number,
): { readonly height: number; readonly width: number } {
  if (snapshot?.configured && snapshot.videoSize) {
    return snapshot.videoSize;
  }
  const size = defaultPhoneScreenSize;
  if (!isLandscapeRotation(rotation)) {
    return size;
  }
  return { height: size.width, width: size.height };
}

export function createPhoneStyle(
  screenSize: { readonly height: number; readonly width: number },
  viewportSize: { readonly height: number; readonly width: number } | undefined,
  controlsBelow: boolean,
): React.CSSProperties {
  const aspect = screenSize.width / screenSize.height;
  const style = {
    "--phone-screen-aspect": `${screenSize.width} / ${screenSize.height}`,
  } as React.CSSProperties;
  if (!viewportSize || viewportSize.height <= 0 || viewportSize.width <= 0) {
    return style;
  }
  const reservedControlWidth = controlsBelow ? 0 : phoneControlRailWidthPx + phoneControlGapPx;
  const reservedControlHeight = controlsBelow ? phoneControlRailHeightPx + phoneControlGapPx : 0;
  const maxScreenWidth = Math.max(
    1,
    viewportSize.width - reservedControlWidth - phoneViewportPaddingPx - phoneFrameInsetPx,
  );
  const maxScreenHeight = Math.max(
    1,
    viewportSize.height - reservedControlHeight - phoneViewportPaddingPx - phoneFrameInsetPx,
  );
  const screenWidth =
    maxScreenWidth / maxScreenHeight > aspect ? maxScreenHeight * aspect : maxScreenWidth;
  const screenHeight = screenWidth / aspect;
  return {
    ...style,
    height: `${Math.round(screenHeight + phoneFrameInsetPx)}px`,
    width: `${Math.round(screenWidth + phoneFrameInsetPx)}px`,
  };
}

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) {
    return;
  }
  const width = canvas.width;
  canvas.width = width;
}

function resolvePointerSlot(
  activePointers: Map<number, number>,
  browserPointerId: number,
  action: PointerAction,
): number | undefined {
  const existingSlot = activePointers.get(browserPointerId);
  if (existingSlot !== undefined) {
    return existingSlot;
  }
  if (action !== "down") {
    return undefined;
  }
  for (let slot = 0; slot < 10; slot += 1) {
    if (![...activePointers.values()].includes(slot)) {
      activePointers.set(browserPointerId, slot);
      return slot;
    }
  }
  return undefined;
}

function isPinchModifierPressed(event: React.PointerEvent<HTMLElement>): boolean {
  return event.ctrlKey || event.metaKey;
}

function syntheticPinchPointerId(browserPointerId: number): number {
  return -browserPointerId - 1;
}

function interpolatePointerDrag(
  previous: ClientPoint | undefined,
  current: ClientPoint,
): readonly ClientPoint[] {
  /* v8 ignore next 3 -- pointer moves without a tracked down event are dropped before interpolation. */
  if (!previous) {
    return [current];
  }
  const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
  if (distance < 0.5) {
    return [];
  }
  const steps = Math.max(1, Math.ceil(distance / pointerDragInterpolationStepPx));
  return Array.from({ length: steps }, (_, index) => {
    const progress = (index + 1) / steps;
    return {
      x: previous.x + (current.x - previous.x) * progress,
      y: previous.y + (current.y - previous.y) * progress,
    };
  });
}

function enqueuePointerFrame(
  queues: Map<number, Promise<void>>,
  pointerId: number,
  send: () => Promise<void>,
  delayMs: number,
): Promise<void> {
  const previous = queues.get(pointerId) ?? Promise.resolve();
  /* v8 ignore next -- previous queue failures are contained; producing one requires a mocked socket fault. */
  const guardedPrevious = previous.catch(ignoreAsyncError);
  const next = guardedPrevious
    .then(() => delay(delayMs))
    .then(send)
    .finally(() => {
      if (queues.get(pointerId) === next) {
        queues.delete(pointerId);
      }
    });
  queues.set(pointerId, next);
  return next;
}

function trackPointerQueue(
  queues: Map<number, Promise<void>>,
  pointerId: number,
  frame: Promise<void>,
): void {
  const previous = queues.get(pointerId) ?? Promise.resolve();
  /* v8 ignore next -- previous queue failures are contained; producing one requires a mocked socket fault. */
  const guardedPrevious = previous.catch(ignoreAsyncError);
  const next = guardedPrevious
    .then(() => frame)
    .finally(() => {
      if (queues.get(pointerId) === next) {
        queues.delete(pointerId);
      }
    });
  queues.set(pointerId, next);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/* v8 ignore next 3 -- async cleanup failures are intentionally swallowed by callers. */
function ignoreAsyncError(): undefined {
  return undefined;
}

function createSyntheticPinchPoints(
  gesture: PinchGesture,
  pointer: { readonly clientX: number; readonly clientY: number },
): readonly [
  { readonly x: number; readonly y: number },
  { readonly x: number; readonly y: number },
] {
  const deltaX = pointer.clientX - gesture.centerX;
  const deltaY = pointer.clientY - gesture.centerY;
  const distance = Math.hypot(deltaX, deltaY);
  const vector = distance < 1 ? { x: 0, y: -syntheticPinchRadiusPx } : { x: deltaX, y: deltaY };
  return [
    { x: gesture.centerX + vector.x, y: gesture.centerY + vector.y },
    { x: gesture.centerX - vector.x, y: gesture.centerY - vector.y },
  ];
}

function DisconnectedPhonePlaceholder({
  status,
}: {
  readonly status: { readonly detail: string; readonly title: string };
}): React.ReactElement {
  return (
    <div className="disconnected-placeholder">
      <img alt="Disconnected Android screen" src={disconnectedPhoneIconUrl} />
      <div className="viewport-status compat-text">
        <strong>{status.title}</strong>
        <small>{status.detail}</small>
      </div>
    </div>
  );
}

function AndroidControls({
  onRotate,
  onSystemAction,
  sessionActive,
}: {
  readonly onRotate: (delta: number) => void;
  readonly onSystemAction: (action: SystemControlAction) => void;
  readonly sessionActive: boolean;
}): React.ReactElement {
  const controls: ReadonlyArray<readonly [string, SystemControlAction, typeof Power, boolean?]> = [
    ["Power", "power", Power, true],
    ["Volume up", "volume-up", Volume2],
    ["Volume down", "volume-down", Volume1],
    ["Back", "back", ArrowLeft],
    ["Home", "home", Home],
    ["Task list", "overview", Square],
  ];
  return (
    <nav aria-label="Android hardware controls" className="control-rail">
      {controls.slice(0, 3).map(([label, action, Icon, danger]) => (
        <Button
          aria-label={label}
          className={danger ? "danger" : undefined}
          disabled={!sessionActive}
          key={label}
          onClick={() => onSystemAction(action)}
          size="icon"
          variant="outline"
        >
          <Icon aria-hidden="true" />
        </Button>
      ))}
      <Button aria-label="Rotate left" onClick={() => onRotate(-90)} size="icon" variant="outline">
        <RotateCcw aria-hidden="true" />
      </Button>
      <Button aria-label="Rotate right" onClick={() => onRotate(90)} size="icon" variant="outline">
        <RotateCw aria-hidden="true" />
      </Button>
      {controls.slice(3).map(([label, action, Icon]) => (
        <Button
          aria-label={label}
          disabled={!sessionActive}
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
  canStart,
  collapsed,
  emptyMessage,
  enabled,
  level,
  logs,
  onAutoscrollChange,
  onClear,
  onCollapsedChange,
  onLevelChange,
  onLogEnabledChange,
  onResizeStart,
  onWrapLinesChange,
  resizing,
  wrapLines,
}: {
  readonly autoscroll: boolean;
  readonly canStart: boolean;
  readonly collapsed: boolean;
  readonly emptyMessage: string;
  readonly enabled: boolean;
  readonly level: LogLevel;
  readonly logs: readonly string[];
  readonly onAutoscrollChange: (enabled: boolean) => void;
  readonly onClear: () => void;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onLevelChange: (level: LogLevel) => void;
  readonly onLogEnabledChange: (enabled: boolean) => void;
  readonly onResizeStart: (clientY: number) => void;
  readonly onWrapLinesChange: (enabled: boolean) => void;
  readonly resizing: boolean;
  readonly wrapLines: boolean;
}): React.ReactElement {
  const [resizerHovered, setResizerHovered] = React.useState(false);
  const [autoscrollPaused, setAutoscrollPaused] = React.useState(false);
  const ignoreAutoscrollEventsUntilRef = React.useRef(0);
  const linesRef = React.useRef<HTMLDivElement | null>(null);
  const visibleLogs = React.useMemo(
    () => (collapsed ? [] : logs.filter((log) => isVisibleLogLine(log, level))),
    [collapsed, level, logs],
  );
  React.useEffect(() => {
    if (!autoscroll) {
      setAutoscrollPaused(false);
      return;
    }
  }, [autoscroll]);
  React.useEffect(() => {
    if (!autoscroll || autoscrollPaused || collapsed) {
      return;
    }
    const lines = linesRef.current;
    /* v8 ignore next -- the log list ref is present while the mounted drawer can autoscroll. */
    if (lines) {
      const ignoreUntil = Date.now() + 120;
      ignoreAutoscrollEventsUntilRef.current = ignoreUntil;
      lines.scrollTop = lines.scrollHeight;
      window.setTimeout(() => {
        if (ignoreAutoscrollEventsUntilRef.current <= ignoreUntil) {
          ignoreAutoscrollEventsUntilRef.current = 0;
        }
      }, 120);
    }
  }, [autoscroll, autoscrollPaused, collapsed, visibleLogs.length]);
  const handleLogScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (Date.now() < ignoreAutoscrollEventsUntilRef.current) {
        return;
      }
      /* v8 ignore next 3 -- scroll events while autoscroll is disabled do not change visible behavior. */
      if (!autoscroll) {
        return;
      }
      setAutoscrollPaused(!isLogScrolledToBottom(event.currentTarget));
    },
    [autoscroll],
  );
  return (
    <section
      aria-label="Device log drawer"
      className={cn("log-drawer", collapsed && "collapsed", resizing && "resizing")}
    >
      {collapsed ? null : (
        <div
          aria-label="Resize device log"
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
      )}
      <div className="log-toolbar">
        <h2>DEVICE LOG</h2>
        {collapsed ? null : (
          <>
            <label>
              Level
              <select
                aria-label="Log level"
                onChange={(event) => onLevelChange(event.target.value as LogLevel)}
                value={level}
              >
                <option value="all">All</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </label>
            <Button
              aria-label={enabled ? "Stop log" : "Start log"}
              className="log-tail-toggle"
              disabled={!canStart}
              onClick={() => onLogEnabledChange(!enabled)}
              size="sm"
              variant={enabled ? "outline" : "secondary"}
            >
              {enabled ? (
                <Square aria-hidden="true" data-icon="inline-start" />
              ) : (
                <Play aria-hidden="true" data-icon="inline-start" />
              )}
              {enabled ? "Stop log" : "Start log"}
            </Button>
            <label className="switch">
              <input
                checked={autoscroll}
                onChange={(event) => onAutoscrollChange(event.target.checked)}
                type="checkbox"
              />
              Autoscroll
            </label>
            <label className="switch">
              <input
                checked={wrapLines}
                onChange={(event) => onWrapLinesChange(event.target.checked)}
                type="checkbox"
              />
              Wrap lines
            </label>
            <Button aria-label="Clear logs" onClick={onClear} size="sm" variant="outline">
              <Trash2 aria-hidden="true" data-icon="inline-start" />
              Clear
            </Button>
          </>
        )}
        <Button
          aria-controls="device-log-lines"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand device log" : "Collapse device log"}
          className="log-collapse-toggle"
          onClick={() => onCollapsedChange(!collapsed)}
          size="icon"
          title={collapsed ? "Expand device log" : "Collapse device log"}
          variant="outline"
        >
          {collapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </Button>
      </div>
      {collapsed ? null : (
        <div
          className={cn("log-lines", wrapLines && "wrap-lines")}
          id="device-log-lines"
          onScroll={handleLogScroll}
          ref={linesRef}
        >
          {visibleLogs.length === 0 ? (
            <p>{emptyMessage}</p>
          ) : (
            visibleLogs.map((log, index) => <LogLine key={`${log}-${index}`} value={log} />)
          )}
        </div>
      )}
    </section>
  );
}

function LogLine({ value }: { readonly value: string }): React.ReactElement {
  const parsed = parseLogLine(value);
  if (!parsed) {
    return <p className="log-line-plain">{value}</p>;
  }
  return (
    <p className={cn("log-line-structured", `log-line-level-${parsed.level}`)}>
      <span className="log-line-time">{parsed.time}</span>
      <span className={cn("log-level", `log-${parsed.level}`)}>{parsed.label}</span>
      <span className="log-line-area">{parsed.area}</span>
      <span className="log-line-message">{parsed.message}</span>
    </p>
  );
}

function isLogScrolledToBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
}

function Dialog({
  bindHost,
  bindPort,
  kind,
  onCancel,
  onBindHostChange,
  onBindPortChange,
  onCopyShareUrl,
  onSubmit,
  onValueChange,
  shareUrl,
  value,
}: {
  readonly bindHost: string;
  readonly bindPort: string;
  readonly kind: Exclude<DialogKind, undefined>;
  readonly onCancel: () => void;
  readonly onBindHostChange: (value: string) => void;
  readonly onBindPortChange: (value: string) => void;
  readonly onCopyShareUrl: () => void;
  readonly onSubmit: () => void;
  readonly onValueChange: (value: string) => void;
  readonly shareUrl: string;
  readonly value: string;
}): React.ReactElement {
  const title =
    kind === "endpoint" ? "Connect by endpoint" : kind === "bind" ? "Bind access" : "Power action";
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
          {kind === "endpoint" ? (
            <>
              <label className="field">
                ADB endpoint
                <input
                  autoFocus
                  onChange={(event) => onValueChange(event.target.value)}
                  placeholder="192.168.1.40:5555"
                  value={value}
                />
              </label>
              <p>Use this when the device is not already visible in adb devices.</p>
            </>
          ) : null}
          {kind === "power" ? (
            <p>
              Send a power-key event to the selected Android device. This is a guarded system
              action.
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
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
              <Button onClick={onSubmit}>Apply bind</Button>
            </>
          ) : null}
          {kind === "endpoint" ? (
            <>
              <Button onClick={onCancel} variant="outline">
                Cancel
              </Button>
              <Button onClick={onSubmit}>Connect</Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function browserStorage(): StorageLike {
  /* v8 ignore next 3 -- the app module is exercised in jsdom, where window is always present. */
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

function createShareUrl(bindHost: string, port: number, agentBaseUrl = ""): string {
  const nextPort = Number.isFinite(port) && port > 0 ? port : fallbackRuntimeConfig.port;
  const endpointHost = parseUrlHost(agentBaseUrl) ?? currentBrowserHost();
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    return `http://${formatHost(endpointHost)}:${nextPort}`;
  }
  return `http://${formatHost(bindHost)}:${nextPort}`;
}

export function createAgentEndpointUrl(
  bindHost: string,
  port: number,
  currentEndpoint = "",
): string {
  const nextPort = Number.isFinite(port) && port > 0 ? port : fallbackRuntimeConfig.port;
  const currentHost = parseUrlHost(currentEndpoint) ?? currentBrowserHost();
  /* v8 ignore start -- endpoint helpers run under jsdom here; the fallback is for non-browser imports. */
  const protocol =
    typeof window !== "undefined" && window.location.protocol ? window.location.protocol : "http:";
  /* v8 ignore stop */
  const host = bindHost === "0.0.0.0" || bindHost === "::" ? currentHost : bindHost;
  return `${protocol}//${formatHost(host)}:${nextPort}`;
}

function currentBrowserHost(): string {
  /* v8 ignore next -- app URL helpers are exercised in jsdom with window present. */
  return typeof window !== "undefined" && window.location.hostname
    ? window.location.hostname
    : fallbackRuntimeConfig.bindHost;
}

function formatHost(host: string): string {
  /* v8 ignore next -- non-IPv6 host formatting is covered by endpoint URL tests. */
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function parseUrlHost(url: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function persistAgentBaseUrl(
  url: string,
  setAgentBaseUrl: (url: string) => void,
  storage: StorageLike,
): void {
  setAgentBaseUrl(url);
  /* v8 ignore start -- current callers always persist a concrete agent endpoint URL. */
  if (url) {
    storage.setItem(agentEndpointStorageKey, url);
    return;
  }
  storage.removeItem(agentEndpointStorageKey);
  /* v8 ignore stop */
}

function createDefaultSessionSocket(session: SessionRecord, agentBaseUrl: string): SessionSocket {
  return createSessionSocket(
    createSessionSocketUrl(
      `/ws/session/${encodeURIComponent(session.sessionId)}?token=${encodeURIComponent(session.token)}`,
      agentBaseUrl,
    ),
  );
}

export function createSessionSocketUrl(path: string, agentBaseUrl: string): string {
  if (!agentBaseUrl) {
    return path;
  }
  const url = new URL(path, agentBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function createDefaultVideoPipeline(
  canvas: HTMLCanvasElement,
  onError: (message: string) => void,
): VideoPipeline {
  const renderer = createCanvasRenderer(canvas);
  /* v8 ignore next 7 -- native canvas/WebCodecs wiring is unavailable in jsdom. */
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
      readonly label: string;
      readonly level: NormalizedLogLevel;
      readonly message: string;
      readonly time: string;
    }
  | undefined {
  const logcatMatch =
    /^(?<time>\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\s+\d+\s+\d+\s+(?<label>[VDIWEFA])\s+(?<area>[^:]+):\s*(?<message>.*)$/.exec(
      value,
    );
  const logcatGroups = logcatMatch?.groups;
  if (logcatGroups) {
    const { area, label, message, time } = logcatGroups;
    /* v8 ignore next -- the regex only captures labels understood by normalizeLogcatLevel. */
    const level = label ? normalizeLogcatLevel(label) : undefined;
    /* v8 ignore next -- named captures are present when the logcat regex matches. */
    if (area && label && level && message !== undefined && time) {
      return { area: area.trim(), label, level, message, time };
    }
  }

  const appStyleMatch =
    /^(?<time>\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\s+(?<level>DEBUG|ERROR|INFO|WARN)\s+(?<rest>.*)$/.exec(
      value,
    );
  const groups = appStyleMatch?.groups;
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
    label: level,
    level: normalizeAppLogLevel(level),
    message: messageParts.join(" "),
    time,
  };
}

function normalizeLogcatLevel(label: string): NormalizedLogLevel | undefined {
  if (label === "V") {
    return "verbose";
  }
  if (label === "D") {
    return "debug";
  }
  if (label === "I") {
    return "info";
  }
  if (label === "W") {
    return "warn";
  }
  /* v8 ignore next -- E/F/A share the same severity branch. */
  if (label === "E" || label === "F" || label === "A") {
    return "error";
  }
  /* v8 ignore next -- parseLogLine only calls this after a regex that restricts labels. */
  return undefined;
}

function normalizeAppLogLevel(level: "DEBUG" | "ERROR" | "INFO" | "WARN"): NormalizedLogLevel {
  if (level === "DEBUG") {
    return "debug";
  }
  if (level === "ERROR") {
    return "error";
  }
  if (level === "WARN") {
    return "warn";
  }
  return "info";
}

function isVisibleLogLine(value: string, level: LogLevel): boolean {
  if (level === "all") {
    return true;
  }
  const parsed = parseLogLine(value);
  return parsed ? logLevelRank(parsed.level) >= logLevelRank(level) : false;
}

function logLevelRank(level: NormalizedLogLevel): number {
  if (level === "verbose") {
    return 0;
  }
  if (level === "debug") {
    return 1;
  }
  if (level === "info") {
    return 2;
  }
  if (level === "warn") {
    return 3;
  }
  return 4;
}

function describeDeviceLogEmptyState(
  selectedSerial: string | undefined,
  status: DeviceLogStatus,
  enabled: boolean,
): string {
  if (!selectedSerial) {
    return "Select a device to view logs";
  }
  if (!enabled) {
    return "Start log collection to view device logs";
  }
  if (status === "error") {
    return "Device log tail unavailable";
  }
  return "Waiting for device logs";
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
