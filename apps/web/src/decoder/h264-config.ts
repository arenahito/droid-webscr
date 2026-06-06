export interface H264Config {
  readonly codec: string;
  readonly codedHeight: number;
  readonly codedWidth: number;
  readonly description?: ArrayBuffer | undefined;
}

export function createBaselineH264Config(width: number, height: number): H264Config {
  return {
    codedHeight: height,
    codedWidth: width,
    codec: "avc1.42E01E",
  };
}

export interface WebCodecsH264ConfigInput {
  readonly codecConfig: Uint8Array;
  readonly height: number;
  readonly width: number;
}

export function createWebCodecsH264Config(input: WebCodecsH264ConfigInput): VideoDecoderConfig {
  if (isAvcDecoderConfigurationRecord(input.codecConfig)) {
    return {
      codec: codecStringFromProfile(
        input.codecConfig[1]!,
        input.codecConfig[2]!,
        input.codecConfig[3]!,
      ),
      codedHeight: input.height,
      codedWidth: input.width,
      description: copyArrayBuffer(input.codecConfig),
    };
  }

  const sps = findAnnexBSps(input.codecConfig);
  if (!sps || sps.byteLength < 4) {
    throw new Error("H.264 codec configuration does not contain SPS metadata.");
  }

  const config = {
    avc: { format: "annexb" },
    codec: codecStringFromProfile(sps[1]!, sps[2]!, sps[3]!),
    codedHeight: input.height,
    codedWidth: input.width,
  };
  return config;
}

function isAvcDecoderConfigurationRecord(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 7 && bytes[0] === 1;
}

function findAnnexBSps(bytes: Uint8Array): Uint8Array | undefined {
  for (let index = 0; index < bytes.byteLength - 4; index += 1) {
    const startCodeLength = annexBStartCodeLength(bytes, index);
    if (startCodeLength === 0) {
      continue;
    }
    const nalStart = index + startCodeLength;
    const nalType = bytes[nalStart]! & 0x1f;
    if (nalType === 7) {
      const nextStart = findNextStartCode(bytes, nalStart + 1);
      return bytes.slice(nalStart, nextStart ?? bytes.byteLength);
    }
  }
  return undefined;
}

function findNextStartCode(bytes: Uint8Array, start: number): number | undefined {
  for (let index = start; index < bytes.byteLength - 3; index += 1) {
    if (annexBStartCodeLength(bytes, index) > 0) {
      return index;
    }
  }
  return undefined;
}

function annexBStartCodeLength(bytes: Uint8Array, index: number): 0 | 3 | 4 {
  if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
    return 3;
  }
  if (
    bytes[index] === 0 &&
    bytes[index + 1] === 0 &&
    bytes[index + 2] === 0 &&
    bytes[index + 3] === 1
  ) {
    return 4;
  }
  return 0;
}

function codecStringFromProfile(profile: number, compatibility: number, level: number): string {
  return `avc1.${toHex(profile)}${toHex(compatibility)}${toHex(level)}`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
