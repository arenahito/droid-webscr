export interface BrowserBinarySocket {
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Uint8Array) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(data: Uint8Array): void;
}
