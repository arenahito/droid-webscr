export type AuthorizationState = "authorized" | "offline" | "unauthorized";
export type TransportKind = "emulator" | "network" | "usb";

export interface DeviceDescriptor {
  readonly authorizationState: AuthorizationState;
  readonly model?: string | undefined;
  readonly serial: string;
  readonly transportKind?: TransportKind | undefined;
}
