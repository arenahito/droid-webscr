import { createTextControlFrame } from "@droid-webscr/protocol";

export interface TextControlInput {
  readonly sequence?: bigint | undefined;
  readonly text: string;
}

export function mapTextToControlFrame(input: TextControlInput): Uint8Array {
  return createTextControlFrame(input);
}
