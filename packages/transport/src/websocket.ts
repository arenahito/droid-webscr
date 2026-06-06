import { ProtocolFrame, encodeFrame } from "@droid-webscr/protocol";

export interface BinaryWebSocketLike {
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export const WEB_SOCKET_OPEN = 1;

export class WebSocketFrameWriter {
  public constructor(private readonly socket: BinaryWebSocketLike) {}

  public send(frame: ProtocolFrame): void {
    if (this.socket.readyState !== WEB_SOCKET_OPEN) {
      throw new Error("WebSocket is not open.");
    }
    this.socket.send(encodeFrame(frame));
  }

  public close(): void {
    this.socket.close();
  }
}
