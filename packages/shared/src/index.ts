export const workspaceNamespace = "@droid-webscr" as const;

export function packageLabel(name: string): string {
  if (name.length === 0) {
    throw new Error("Package name must not be empty.");
  }

  return `${workspaceNamespace}/${name}`;
}
