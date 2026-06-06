export interface AdbDeviceDescriptor {
  readonly serial: string;
  readonly state: "device" | "offline" | "unauthorized";
}

export function isUsableDevice(device: AdbDeviceDescriptor): boolean {
  return device.state === "device" && device.serial.length > 0;
}
