export const binaryWebSocketProtocol = "droid-webscr.v1";

export interface BinarySocket {
  binaryType: BinaryType;
  readonly protocol: string;
  readonly readyState: number;
  addEventListener(event: "error", listener: (event: Event) => void): void;
  addEventListener(event: "close", listener: () => void): void;
  addEventListener(event: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(event: "open", listener: () => void): void;
  close(): void;
  send(data: Uint8Array): void;
}

export type BinarySocketFactory = (url: string, protocol: string) => BinarySocket;

export function createSessionSocket(
  url: string,
  socketFactory: BinarySocketFactory = createNativeBinarySocket,
): SessionSocket {
  const socket = socketFactory(url, binaryWebSocketProtocol);
  socket.binaryType = "arraybuffer";
  return new SessionSocket(socket);
}

export function createNativeBinarySocket(url: string, protocol: string): BinarySocket {
  return new NativeBinarySocketAdapter(new WebSocket(url, protocol));
}

export class SessionSocket {
  public constructor(private readonly socket: BinarySocket) {}

  public waitUntilOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => {
        if (this.socket.protocol !== binaryWebSocketProtocol) {
          reject(
            new Error(
              `Unsupported WebSocket protocol negotiated: ${this.socket.protocol || "<none>"}`,
            ),
          );
          return;
        }
        resolve();
      });
      this.socket.addEventListener("error", () => {
        reject(new Error("Session WebSocket failed before opening."));
      });
    });
  }

  public onFrame(listener: (frame: Uint8Array) => void): void {
    this.socket.addEventListener("message", (event) => {
      if (event.data instanceof Uint8Array) {
        listener(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        listener(new Uint8Array(event.data));
      }
    });
  }

  public onClose(listener: () => void): void {
    this.socket.addEventListener("close", listener);
  }

  public async send(frame: Uint8Array): Promise<void> {
    this.socket.send(frame);
  }

  public close(): void {
    this.socket.close();
  }
}

class NativeBinarySocketAdapter implements BinarySocket {
  public constructor(private readonly socket: WebSocket) {}

  public get binaryType(): BinaryType {
    return this.socket.binaryType;
  }

  public set binaryType(value: BinaryType) {
    this.socket.binaryType = value;
  }

  public get protocol(): string {
    return this.socket.protocol;
  }

  public get readyState(): number {
    return this.socket.readyState;
  }

  public addEventListener(event: "error", listener: (event: Event) => void): void;
  public addEventListener(event: "close", listener: () => void): void;
  public addEventListener(
    event: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  public addEventListener(event: "open", listener: () => void): void;
  public addEventListener(
    event: "close" | "error" | "message" | "open",
    listener:
      | ((event: Event) => void)
      | ((event: { readonly data: unknown }) => void)
      | (() => void),
  ): void {
    this.socket.addEventListener(event, listener as EventListener);
  }

  public send(data: Uint8Array): void {
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    this.socket.send(bytes.buffer);
  }

  public close(): void {
    this.socket.close();
  }
}

export class FakeBinaryWebSocket implements BinarySocket {
  public binaryType: BinaryType = "blob";
  public readyState = 0;
  public readonly sent: Uint8Array[] = [];
  public closed = false;
  private readonly closeListeners: Array<() => void> = [];
  private readonly errorListeners: Array<(event: Event) => void> = [];
  private readonly listeners: Array<(event: { readonly data: unknown }) => void> = [];
  private readonly openListeners: Array<() => void> = [];

  public constructor(public readonly protocol = binaryWebSocketProtocol) {}

  public addEventListener(
    event: "close" | "error" | "message" | "open",
    listener:
      | ((event: Event) => void)
      | ((event: { readonly data: unknown }) => void)
      | (() => void),
  ): void {
    if (event === "close") {
      this.closeListeners.push(listener as () => void);
      return;
    }
    if (event === "error") {
      this.errorListeners.push(listener as (event: Event) => void);
      return;
    }
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      return;
    }
    this.listeners.push(listener as (event: { readonly data: unknown }) => void);
  }

  public open(): void {
    this.readyState = 1;
    for (const listener of this.openListeners) {
      listener();
    }
  }

  public fail(): void {
    for (const listener of this.errorListeners) {
      listener(new Event("error"));
    }
  }

  public receive(frame: unknown): void {
    for (const listener of this.listeners) {
      listener({ data: frame });
    }
  }

  public remoteClose(): void {
    this.closed = true;
    this.readyState = 3;
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  public send(data: Uint8Array): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}
