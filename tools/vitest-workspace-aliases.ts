import { fileURLToPath } from "node:url";

export const workspaceAliases = {
  "@droid-webscr/adb": fileURLToPath(new URL("../packages/adb/src/index.ts", import.meta.url)),
  "@droid-webscr/config": fileURLToPath(
    new URL("../packages/config/src/index.ts", import.meta.url),
  ),
  "@droid-webscr/protocol": fileURLToPath(
    new URL("../packages/protocol/src/index.ts", import.meta.url),
  ),
  "@droid-webscr/shared": fileURLToPath(
    new URL("../packages/shared/src/index.ts", import.meta.url),
  ),
  "@droid-webscr/transport": fileURLToPath(
    new URL("../packages/transport/src/index.ts", import.meta.url),
  ),
};
