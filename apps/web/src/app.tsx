import * as React from "react";
import {
  Activity,
  ArrowLeft,
  Clipboard,
  Home,
  Keyboard,
  MonitorSmartphone,
  Moon,
  Power,
  RotateCcw,
  RotateCw,
  Search,
  Share2,
  Smartphone,
  Sun,
  Volume2,
} from "lucide-react";
import { Button } from "./components/ui/button.js";
import { DeviceDescriptor } from "./features/devices/device-types.js";
import { AgentClient, createHttpAgentClient } from "./features/session/agent-client.js";
import {
  reduceSessionState,
  SessionRecord,
  SessionState,
} from "./features/session/session-state.js";
import { createMemoryStorage, StorageLike } from "./lib/memory-storage.js";
import { cn } from "./lib/utils.js";
import { applyTheme, persistTheme, readTheme, ThemePreference } from "./theme/theme.js";

export interface DroidWebscrAppProps {
  readonly client?: AgentClient | undefined;
  readonly initialLogs?: readonly string[] | undefined;
  readonly storage?: StorageLike | undefined;
}

const defaultSessionState: SessionState = {
  logs: [],
  phase: "idle",
  selectedSerial: undefined,
  session: undefined,
};

export function DroidWebscrApp({
  client,
  initialLogs = ["Agent ready"],
  storage = browserStorage(),
}: DroidWebscrAppProps): React.ReactElement {
  const agentClient = React.useMemo(() => {
    /* v8 ignore start -- client selection is exercised through component tests and client tests */
    if (client) {
      return client;
    }
    return createHttpAgentClient();
    /* v8 ignore stop */
  }, [client]);
  const [devices, setDevices] = React.useState<readonly DeviceDescriptor[]>([]);
  const [loadingDevices, setLoadingDevices] = React.useState(true);
  const [theme, setTheme] = React.useState<ThemePreference>(() => readTheme(storage));
  const [state, dispatch] = React.useReducer(reduceSessionState, {
    ...defaultSessionState,
    logs: initialLogs,
  });
  const selectedDevice = devices.find((device) => device.serial === state.selectedSerial);

  React.useEffect(() => {
    applyTheme(theme);
    persistTheme(storage, theme);
  }, [storage, theme]);

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
  }, [refreshDevices]);

  const startSession = async () => {
    /* v8 ignore next 3 -- Start is disabled until a device is selected */
    if (!state.selectedSerial) {
      return;
    }
    dispatch({ type: "start-requested" });
    try {
      const session = await agentClient.createSession(state.selectedSerial);
      dispatch({ session, type: "start-succeeded" });
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : "Session creation failed",
        type: "failed",
      });
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col gap-3 p-3">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-panel px-3 py-2">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <MonitorSmartphone aria-hidden="true" data-icon="inline-start" />
            </div>
            <div>
              <h1 className="text-base font-semibold">droid-webscr</h1>
              <p className="text-xs text-muted-foreground">Local Android screen control</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusText session={state.session} />
            <Button
              aria-label={theme === "dark" ? "Light theme" : "Dark theme"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              size="icon"
              variant="outline"
            >
              {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </Button>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] gap-3 max-lg:grid-cols-1">
          <DeviceSelector
            devices={devices}
            loading={loadingDevices}
            onRefresh={refreshDevices}
            onSelect={(serial) => dispatch({ serial, type: "select-device" })}
            selectedSerial={state.selectedSerial}
          />

          <div className="flex min-w-0 flex-col gap-3">
            <SessionToolbar
              disabled={!selectedDevice || selectedDevice.authorizationState !== "authorized"}
              phase={state.phase}
              session={state.session}
              startSession={startSession}
              stopSession={() => dispatch({ type: "stop" })}
            />
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_72px] gap-3 max-md:grid-cols-1">
              <AndroidViewport device={selectedDevice} />
              <AndroidControls />
            </div>
          </div>
        </section>

        <AccessBar />
        <LogDrawer logs={state.logs} onClear={() => dispatch({ type: "clear-logs" })} />
      </div>
    </main>
  );
}

function DeviceSelector({
  devices,
  loading,
  onRefresh,
  onSelect,
  selectedSerial,
}: {
  readonly devices: readonly DeviceDescriptor[];
  readonly loading: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onSelect: (serial: string) => void;
  readonly selectedSerial: string | undefined;
}): React.ReactElement {
  return (
    <aside className="flex min-h-0 flex-col gap-3 rounded-md border border-border bg-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Devices</h2>
        <Button onClick={() => void onRefresh()} size="sm" variant="outline">
          <Search aria-hidden="true" data-icon="inline-start" />
          Scan adb devices
        </Button>
      </div>
      <Button className="w-full" variant="secondary">
        <Share2 aria-hidden="true" data-icon="inline-start" />
        Connect by endpoint
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {devices.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            {loading ? "Scanning devices" : "No Android devices detected"}
          </div>
        ) : (
          devices.map((device) => (
            <button
              aria-label={`${device.model ?? "Android device"} ${device.serial}`}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border border-border bg-background p-3 text-left text-sm hover:bg-muted",
                selectedSerial === device.serial && "border-primary",
              )}
              key={device.serial}
              onClick={() => onSelect(device.serial)}
              type="button"
            >
              <Smartphone aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {device.model ?? "Android device"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {device.serial}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">{device.authorizationState}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

function SessionToolbar({
  disabled,
  phase,
  session,
  startSession,
  stopSession,
}: {
  readonly disabled: boolean;
  readonly phase: SessionState["phase"];
  readonly session: SessionRecord | undefined;
  readonly startSession: () => Promise<void>;
  readonly stopSession: () => void;
}): React.ReactElement {
  return (
    <section className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-panel p-2">
      {session ? (
        <Button onClick={stopSession} variant="outline">
          <Power aria-hidden="true" data-icon="inline-start" />
          Stop
        </Button>
      ) : (
        <Button disabled={disabled || phase === "starting"} onClick={() => void startSession()}>
          <Power aria-hidden="true" data-icon="inline-start" />
          Start
        </Button>
      )}
      <Button variant="outline">
        <RotateCcw aria-hidden="true" data-icon="inline-start" />
        Left 90
      </Button>
      <Button variant="outline">
        <RotateCw aria-hidden="true" data-icon="inline-start" />
        Right 90
      </Button>
      <Button variant="outline">Bitrate 8 Mbps</Button>
      <Button variant="outline">FPS 30</Button>
      <Button variant="outline">Capture</Button>
      <Button variant="outline">Record</Button>
    </section>
  );
}

function AndroidViewport({
  device,
}: {
  readonly device: DeviceDescriptor | undefined;
}): React.ReactElement {
  return (
    <section
      aria-label="Android screen viewport"
      className="flex min-h-[460px] items-center justify-center rounded-md border border-border bg-viewport p-4"
    >
      <div className="flex aspect-[9/16] max-h-[72vh] w-full max-w-[390px] flex-col overflow-hidden rounded-md border border-screen-border bg-screen shadow-2xl">
        <div className="flex items-center justify-between bg-screen-chrome px-3 py-2 text-xs text-screen-muted">
          <span>{device?.model ?? "Android device"}</span>
          <span>{device?.serial ?? "waiting"}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <Activity aria-hidden="true" className="mx-auto mb-3 text-primary" />
            <p className="text-sm font-medium">Viewport fit active</p>
            <p className="mt-1 text-xs text-screen-muted">Video decoder boundary ready</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function AndroidControls(): React.ReactElement {
  const controls = [
    ["Keyboard", Keyboard],
    ["Home", Home],
    ["Back", ArrowLeft],
    ["Overview", MonitorSmartphone],
    ["Volume", Volume2],
    ["Power", Power],
  ] as const;
  return (
    <nav className="flex flex-col gap-2 rounded-md border border-border bg-panel p-2 max-md:flex-row max-md:flex-wrap">
      {controls.map(([label, Icon]) => (
        <Button aria-label={label} key={label} size="icon" variant="outline">
          <Icon aria-hidden="true" />
        </Button>
      ))}
    </nav>
  );
}

function AccessBar(): React.ReactElement {
  return (
    <section className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm">
      <span>Bind 127.0.0.1</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline">
          <Clipboard aria-hidden="true" data-icon="inline-start" />
          Share URL
        </Button>
        <Button size="sm" variant="outline">
          Clipboard off
        </Button>
      </div>
    </section>
  );
}

function LogDrawer({
  logs,
  onClear,
}: {
  readonly logs: readonly string[];
  readonly onClear: () => void;
}): React.ReactElement {
  const visibleLogs = logs.filter((log) => log.length > 0);
  return (
    <section aria-label="Log drawer" className="rounded-md border border-border bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Logs</h2>
        <Button onClick={onClear} size="sm" variant="outline">
          Clear logs
        </Button>
      </div>
      <div className="h-40 overflow-auto p-3 font-mono text-xs text-muted-foreground">
        {visibleLogs.length === 0 ? (
          <p>No logs</p>
        ) : (
          visibleLogs.map((log, index) => <p key={`${log}-${index}`}>{log}</p>)
        )}
      </div>
    </section>
  );
}

function StatusText({
  session,
}: {
  readonly session: SessionRecord | undefined;
}): React.ReactElement {
  return (
    <span className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
      {session ? `Session ${session.sessionId}` : "No session"}
    </span>
  );
}

function browserStorage(): StorageLike {
  /* v8 ignore next 3 -- browser app fallback for non-DOM imports */
  if (typeof window === "undefined") {
    return createMemoryStorage();
  }
  return window.localStorage;
}
