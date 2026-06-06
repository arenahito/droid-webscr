import { describeProtocol } from "@droid-webscr/protocol";

export function webClientLabel(): string {
  return `droid-webscr ${describeProtocol()}`;
}
