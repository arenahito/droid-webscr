export interface SessionRecord {
  readonly sessionId: string;
  readonly serial: string;
  readonly token: string;
}

export interface SessionState {
  readonly logs: readonly string[];
  readonly phase: "idle" | "starting" | "connected" | "error";
  readonly selectedSerial: string | undefined;
  readonly session: SessionRecord | undefined;
}

export type SessionAction =
  | { readonly serial: string; readonly type: "select-device" }
  | { readonly type: "start-requested" }
  | { readonly session: SessionRecord; readonly type: "start-succeeded" }
  | { readonly message: string; readonly type: "failed" }
  | { readonly message: string; readonly type: "log" }
  | { readonly type: "stop" }
  | { readonly type: "clear-logs" };

export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "select-device":
      return { ...state, selectedSerial: action.serial };
    case "start-requested":
      return { ...state, phase: "starting" };
    case "start-succeeded":
      return {
        ...state,
        logs: [...state.logs, `Session ${action.session.sessionId} connected`],
        phase: "connected",
        selectedSerial: action.session.serial,
        session: action.session,
      };
    case "failed":
      return { ...state, logs: [...state.logs, action.message], phase: "error" };
    case "log":
      return { ...state, logs: [...state.logs, action.message] };
    case "stop":
      return {
        ...state,
        logs: [...state.logs, "Session stopped"],
        phase: "idle",
        session: undefined,
      };
    case "clear-logs":
      return { ...state, logs: [] };
  }
}
