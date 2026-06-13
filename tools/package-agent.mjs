import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const agentRoot = join(root, "apps", "agent");
const artifactName = "droid-webscr-server-android.jar";
const sourceArtifact = join(root, "android", "server", "build", artifactName);
const packageArtifact = join(agentRoot, "android", artifactName);

await copyRequiredFile(sourceArtifact, packageArtifact);
await copyRequiredFile(join(root, "README.md"), join(agentRoot, "README.md"));
await copyRequiredFile(join(root, "LICENSE"), join(agentRoot, "LICENSE"));

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
