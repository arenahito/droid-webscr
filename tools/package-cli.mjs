import { constants } from "node:fs";
import { access, cp, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cliRoot = join(root, "apps", "cli");
const artifactName = "droid-webscr-server-android.jar";

await copyRequiredFile(
  join(root, "android", "server", "build", artifactName),
  join(cliRoot, "android", artifactName),
);
await copyRequiredDirectory(join(root, "apps", "web", "dist"), join(cliRoot, "web"));
await copyRequiredFile(join(root, "README.md"), join(cliRoot, "README.md"));
await copyRequiredFile(join(root, "LICENSE"), join(cliRoot, "LICENSE"));

async function copyRequiredDirectory(source, destination) {
  await assertReadable(source);
  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function copyRequiredFile(source, destination) {
  await assertReadable(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function assertReadable(path) {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(`Required packaging input is missing: ${path}`);
  }
}
