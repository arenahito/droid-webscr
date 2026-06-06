export interface H264Config {
  readonly codec: "avc1.42E01E";
  readonly codedHeight: number;
  readonly codedWidth: number;
}

export function createBaselineH264Config(width: number, height: number): H264Config {
  return {
    codedHeight: height,
    codedWidth: width,
    codec: "avc1.42E01E",
  };
}
