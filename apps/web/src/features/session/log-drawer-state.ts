const MIN_LOG_DRAWER_HEIGHT = 160;
const MAX_LOG_DRAWER_HEIGHT = 520;

export function appendLog(logs: readonly string[], entry: string): readonly string[] {
  return [...logs, entry];
}

export function clearLogs(_logs: readonly string[]): readonly string[] {
  return [];
}

export function resizeLogDrawer(height: number): number {
  return Math.min(MAX_LOG_DRAWER_HEIGHT, Math.max(MIN_LOG_DRAWER_HEIGHT, Math.round(height)));
}
