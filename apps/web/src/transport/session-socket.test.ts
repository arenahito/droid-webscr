import { afterEach, describe, expect, it, vi } from "vitest";
import {
  binaryWebSocketProtocol,
  createNativeBinarySocket,
  createSessionSocket,
  FakeBinaryWebSocket,
  SessionSocket,
} from "./session-socket.js";

describe("session socket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens with the binary subprotocol and passes frames unchanged", async () => {
    const socket = new FakeBinaryWebSocket();
    const session = new SessionSocket(socket);
    const received: number[][] = [];
    session.onFrame((frame) => received.push(Array.from(frame)));

    socket.open();
    await session.send(new Uint8Array([1, 2, 3]));
    socket.receive(new Uint8Array([4, 5, 6]));
    socket.receive(new Uint8Array([7, 8]).buffer);
    socket.receive("ignored");

    expect(socket.protocol).toBe("droid-webscr.v1");
    expect(socket.sent.map((frame) => Array.from(frame))).toEqual([[1, 2, 3]]);
    expect(received).toEqual([
      [4, 5, 6],
      [7, 8],
    ]);
  });

  it("constructs native sockets with the required subprotocol and arraybuffer frames", () => {
    const created: Array<{
      readonly protocol: string;
      readonly socket: FakeBinaryWebSocket;
      readonly url: string;
    }> = [];
    const createSocket = (url: string, protocol: string) => {
      const socket = new FakeBinaryWebSocket(protocol);
      created.push({ protocol, socket, url });
      return socket;
    };

    createSessionSocket("ws://127.0.0.1:7391/ws/session/s1?token=t1", createSocket);

    expect(created).toHaveLength(1);
    expect(created[0]?.url).toBe("ws://127.0.0.1:7391/ws/session/s1?token=t1");
    expect(created[0]?.protocol).toBe(binaryWebSocketProtocol);
    expect(created[0]?.socket.binaryType).toBe("arraybuffer");
  });

  it("adapts native browser WebSockets to the binary transport contract", async () => {
    const created: NativeSocketStub[] = [];
    class NativeSocketStub {
      public binaryType: BinaryType = "blob";
      public readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
      public protocol = binaryWebSocketProtocol;
      public readyState = 0;
      public sent: ArrayBuffer | undefined;

      public constructor(
        public readonly url: string,
        public readonly requestedProtocol: string,
      ) {
        created.push(this);
      }

      public addEventListener(event: string, listener: (event?: unknown) => void): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      }

      public emit(event: string, payload?: unknown): void {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(payload);
        }
      }

      public send(data: string | Blob | BufferSource): void {
        if (!(data instanceof ArrayBuffer)) {
          throw new Error("Expected ArrayBuffer payload");
        }
        this.sent = data;
      }

      public close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", NativeSocketStub);

    const adapter = createNativeBinarySocket("ws://127.0.0.1:7391/ws/session/s2?token=t2", "p2");
    adapter.binaryType = "arraybuffer";
    created[0]!.readyState = 1;
    expect(adapter.binaryType).toBe("arraybuffer");
    expect(adapter.readyState).toBe(1);

    const session = createSessionSocket("ws://127.0.0.1:7391/ws/session/s1?token=t1");
    const received: number[][] = [];
    session.onFrame((frame) => received.push(Array.from(frame)));
    const opened = session.waitUntilOpen();
    const socket = created[1];

    expect(socket?.url).toBe("ws://127.0.0.1:7391/ws/session/s1?token=t1");
    expect(socket?.requestedProtocol).toBe(binaryWebSocketProtocol);
    expect(socket?.binaryType).toBe("arraybuffer");

    socket?.emit("open");
    await expect(opened).resolves.toBeUndefined();
    await session.send(new Uint8Array([9, 8, 7]).subarray(1));
    socket?.emit("message", { data: new Uint8Array([4, 3]).buffer });
    session.close();

    expect(socket?.sent ? Array.from(new Uint8Array(socket.sent)) : []).toEqual([8, 7]);
    expect(socket?.readyState).toBe(3);
    expect(received).toEqual([[4, 3]]);
  });

  it("rejects sockets that negotiate the wrong subprotocol", async () => {
    const socket = new FakeBinaryWebSocket("legacy-json");
    const session = new SessionSocket(socket);
    const opened = session.waitUntilOpen();

    socket.open();

    await expect(opened).rejects.toThrow("Unsupported WebSocket protocol negotiated: legacy-json");

    const missingProtocol = new FakeBinaryWebSocket("");
    const missingOpened = new SessionSocket(missingProtocol).waitUntilOpen();
    missingProtocol.open();

    await expect(missingOpened).rejects.toThrow(
      "Unsupported WebSocket protocol negotiated: <none>",
    );
  });

  it("resolves and rejects real open lifecycle outcomes", async () => {
    const accepted = new FakeBinaryWebSocket();
    const connected = new SessionSocket(accepted).waitUntilOpen();
    accepted.open();
    await expect(connected).resolves.toBeUndefined();

    const failed = new FakeBinaryWebSocket();
    const opening = new SessionSocket(failed).waitUntilOpen();
    failed.fail();
    await expect(opening).rejects.toThrow("Session WebSocket failed before opening.");
  });
});
