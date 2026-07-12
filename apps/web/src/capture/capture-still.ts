export interface ClipboardPngWriter {
  readonly ClipboardItem: new (items: Record<string, Blob>) => unknown;
  readonly write: (items: readonly unknown[]) => Promise<void>;
}

export function captureCanvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("PNG capture failed"));
    }, "image/png");
  });
}

export async function copyPngToClipboard(
  png: Blob,
  writer: ClipboardPngWriter = browserClipboardPngWriter(),
): Promise<void> {
  const item = new writer.ClipboardItem({ "image/png": png });
  await writer.write([item]);
}

function browserClipboardPngWriter(): ClipboardPngWriter {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("PNG clipboard copy is unavailable");
  }
  return {
    ClipboardItem,
    write: (items) => navigator.clipboard.write(items as ClipboardItem[]),
  };
}
