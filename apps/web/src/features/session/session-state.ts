export interface SessionRecord {
  readonly sessionId: string;
  readonly serial: string;
  readonly token: string;
}

export interface SessionState {
  readonly phase: "idle" | "starting" | "connected" | "error";
  readonly selectedSerial: string | undefined;
  readonly session: SessionRecord | undefined;
}

export type SessionAction =
  | { readonly serial: string; readonly type: "select-device" }
  | { readonly type: "start-requested" }
  | { readonly session: SessionRecord; readonly type: "start-succeeded" }
  | { readonly domain?: ErrorDomain | undefined; readonly message: string; readonly type: "failed" }
  | { readonly type: "stop" };

export type ErrorDomain = "agent" | "android" | "network" | "protocol" | "security" | "unknown";

export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "select-device":
      return { ...state, selectedSerial: action.serial };
    case "start-requested":
      return { ...state, phase: "starting" };
    case "start-succeeded":
      return {
        ...state,
        phase: "connected",
        selectedSerial: action.session.serial,
        session: action.session,
      };
    case "failed":
      return {
        ...state,
        phase: "error",
      };
    case "stop":
      return {
        ...state,
        phase: "idle",
        session: undefined,
      };
  }
}
