export const protocolMagic = "DWSC" as const;
export const protocolVersion = 1 as const;

export function describeProtocol(): string {
  return `${protocolMagic}/v${protocolVersion}`;
}
