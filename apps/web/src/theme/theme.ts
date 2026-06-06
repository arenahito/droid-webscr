import { StorageLike } from "../lib/memory-storage.js";

export type ThemePreference = "dark" | "light";
export const themeStorageKey = "droid-webscr.theme";

export function readTheme(storage: StorageLike): ThemePreference {
  return storage.getItem(themeStorageKey) === "light" ? "light" : "dark";
}

export function persistTheme(storage: StorageLike, theme: ThemePreference): void {
  storage.setItem(themeStorageKey, theme);
}

export function applyTheme(
  theme: ThemePreference,
  target: HTMLElement = document.documentElement,
): void {
  target.dataset.theme = theme;
}
