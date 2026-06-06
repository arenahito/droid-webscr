import { describe, expect, it } from "vitest";
import { reduceSessionState } from "./session-state.js";

describe("session state", () => {
  it("tracks start stop and error transitions without losing selected device", () => {
    const selected = reduceSessionState(
      { logs: [], phase: "idle", selectedSerial: undefined, session: undefined },
      { serial: "emulator-5554", type: "select-device" },
    );
    const starting = reduceSessionState(selected, { type: "start-requested" });
    const connected = reduceSessionState(starting, {
      session: { sessionId: "s1", serial: "emulator-5554", token: "t1" },
      type: "start-succeeded",
    });
    const failed = reduceSessionState(connected, { message: "socket closed", type: "failed" });
    const logged = reduceSessionState(connected, {
      message: "Decode pressure detected",
      type: "log",
    });
    const stopped = reduceSessionState(failed, { type: "stop" });

    expect(starting.phase).toBe("starting");
    expect(connected.session?.sessionId).toBe("s1");
    expect(failed.logs.at(-1)).toBe("socket closed");
    expect(logged.phase).toBe("connected");
    expect(logged.logs.at(-1)).toBe("Decode pressure detected");
    expect(stopped).toMatchObject({ phase: "idle", selectedSerial: "emulator-5554" });
  });

  it("maps typed error domains to stable user-facing log text", () => {
    const failed = reduceSessionState(
      { logs: [], phase: "connected", selectedSerial: "emulator-5554", session: undefined },
      { domain: "security", message: "Invalid origin", type: "failed" },
    );

    expect(failed.phase).toBe("error");
    expect(failed.logs).toEqual(["Security error: Invalid origin"]);
  });
});
