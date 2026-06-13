const MIN_LOG_DRAWER_HEIGHT = 160;
const MAX_LOG_DRAWER_HEIGHT = 520;
const MAX_LOG_LINES = 5000;

export function appendLog(logs: readonly string[], entry: string): readonly string[] {
  return appendLogs(logs, [entry]);
}

export function appendLogs(logs: readonly string[], entries: readonly string[]): readonly string[] {
  if (entries.length === 0) {
    return logs;
  }
  const nextLogs = [...logs, ...entries];
  return nextLogs.length > MAX_LOG_LINES
    ? nextLogs.slice(nextLogs.length - MAX_LOG_LINES)
    : nextLogs;
}

export function clearLogs(_logs: readonly string[]): readonly string[] {
  return [];
}

export function resizeLogDrawer(height: number): number {
  return Math.min(MAX_LOG_DRAWER_HEIGHT, Math.max(MIN_LOG_DRAWER_HEIGHT, Math.round(height)));
}
