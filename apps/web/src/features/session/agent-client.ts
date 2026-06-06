import { DeviceDescriptor } from "../devices/device-types.js";
import { SessionRecord } from "./session-state.js";

export interface AgentClient {
  connectEndpoint?(endpoint: string): Promise<DeviceActionResult>;
  createSession(serial: string): Promise<SessionRecord>;
  disconnectDevice?(serial: string): Promise<DeviceActionResult>;
  getRuntimeConfig?(): Promise<RuntimeConfig>;
  listDevices(): Promise<readonly DeviceDescriptor[]>;
  renameDevice?(serial: string, alias: string): Promise<DeviceActionResult>;
  saveRuntimeBind?(bindHost: string, port: number): Promise<RuntimeBindResult>;
  saveRuntimeClipboard?(enabled: boolean): Promise<RuntimeClipboardResult>;
  scanDevices?(): Promise<readonly DeviceDescriptor[]>;
  shareUrl?(): Promise<ShareUrlResult>;
}

export interface DeviceActionResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface RuntimeConfig {
  readonly bindHost: string;
  readonly clipboardEnabled: boolean;
  readonly port: number;
}

export interface RuntimeBindResult extends DeviceActionResult, RuntimeConfig {
  readonly shareUrl: string;
}

export interface RuntimeClipboardResult extends DeviceActionResult, RuntimeConfig {}

export interface ShareUrlResult {
  readonly url: string;
}

export interface HttpAgentClientOptions {
  readonly authToken?: string | undefined;
  readonly baseUrl?: string | undefined;
}

export function createHttpAgentClient(options: HttpAgentClientOptions | string = ""): AgentClient {
  const baseUrl = typeof options === "string" ? options : (options.baseUrl ?? "");
  const authToken = typeof options === "string" ? undefined : options.authToken;
  const headers = createAgentHeaders(authToken);
  return {
    createSession: async (serial) => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        body: JSON.stringify({ serial }),
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Session creation failed with HTTP ${response.status}`);
      }
      return (await response.json()) as SessionRecord;
    },
    connectEndpoint: async (endpoint) =>
      postJson<DeviceActionResult>(`${baseUrl}/api/devices/connect`, { endpoint }, headers),
    disconnectDevice: async (serial) =>
      postJson<DeviceActionResult>(
        `${baseUrl}/api/devices/${encodeURIComponent(serial)}/disconnect`,
        {},
        headers,
      ),
    getRuntimeConfig: async () => {
      const response = await fetch(`${baseUrl}/api/config`, { headers });
      if (!response.ok) {
        throw new Error(`Runtime config failed with HTTP ${response.status}`);
      }
      return (await response.json()) as RuntimeConfig;
    },
    listDevices: async () => {
      const response = await fetch(`${baseUrl}/api/devices`, { headers });
      if (!response.ok) {
        throw new Error(`Device listing failed with HTTP ${response.status}`);
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Agent API did not return a device JSON response");
      }
      const body = (await response.json()) as { readonly devices: readonly DeviceDescriptor[] };
      return body.devices;
    },
    renameDevice: async (serial, alias) =>
      postJson<DeviceActionResult>(
        `${baseUrl}/api/devices/${encodeURIComponent(serial)}/rename`,
        { alias },
        headers,
      ),
    saveRuntimeBind: async (bindHost, port) =>
      postJson<RuntimeBindResult>(`${baseUrl}/api/config/bind`, { bindHost, port }, headers, {
        method: "PATCH",
      }),
    saveRuntimeClipboard: async (enabled) =>
      postJson<RuntimeClipboardResult>(`${baseUrl}/api/config/clipboard`, { enabled }, headers, {
        method: "PATCH",
      }),
    scanDevices: async () => {
      const response = await fetch(`${baseUrl}/api/devices/scan`, { headers, method: "POST" });
      if (!response.ok) {
        throw new Error(`Device scan failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as { readonly devices: readonly DeviceDescriptor[] };
      return body.devices;
    },
    shareUrl: async () => {
      const response = await fetch(`${baseUrl}/api/share-url`, { headers });
      if (!response.ok) {
        throw new Error(`Share URL failed with HTTP ${response.status}`);
      }
      return (await response.json()) as ShareUrlResult;
    },
  };
}

function createAgentHeaders(authToken: string | undefined): HeadersInit {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: HeadersInit,
  options: { readonly method?: "PATCH" | "POST" } = {},
): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { ...headers, "content-type": "application/json" },
    method: options.method ?? "POST",
  });
  if (!response.ok) {
    throw new Error(`Agent request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
