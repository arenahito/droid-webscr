import { DeviceDescriptor } from "../devices/device-types.js";
import { SessionRecord } from "./session-state.js";

export interface AgentClient {
  createSession(serial: string): Promise<SessionRecord>;
  listDevices(): Promise<readonly DeviceDescriptor[]>;
}

export function createHttpAgentClient(baseUrl = ""): AgentClient {
  return {
    createSession: async (serial) => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        body: JSON.stringify({ serial }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Session creation failed with HTTP ${response.status}`);
      }
      return (await response.json()) as SessionRecord;
    },
    listDevices: async () => {
      const response = await fetch(`${baseUrl}/api/devices`);
      if (!response.ok) {
        throw new Error(`Device listing failed with HTTP ${response.status}`);
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Agent API did not return a device JSON response");
      }
      const body = (await response.json()) as { readonly devices: readonly DeviceDescriptor[] };
      return body.devices;
    },
  };
}
