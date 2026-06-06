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
    const stopped = reduceSessionState(failed, { type: "stop" });

    expect(starting.phase).toBe("starting");
    expect(connected.session?.sessionId).toBe("s1");
    expect(failed.logs.at(-1)).toBe("socket closed");
    expect(stopped).toMatchObject({ phase: "idle", selectedSerial: "emulator-5554" });
  });
});
