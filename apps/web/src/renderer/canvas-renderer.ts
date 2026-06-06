export interface CanvasRenderer {
  clear(): void;
  resize(size: VideoSize): void;
  render(frame: VideoFrame): void;
}

export interface VideoSize {
  readonly height: number;
  readonly width: number;
}

export interface CanvasFit {
  readonly height: number;
  readonly left: number;
  readonly scale: number;
  readonly top: number;
  readonly width: number;
}

export function fitCanvasToViewport(video: VideoSize, viewport: VideoSize): CanvasFit {
  const scale = Math.min(viewport.width / video.width, viewport.height / video.height);
  const width = Math.round(video.width * scale);
  const height = Math.round(video.height * scale);
  return {
    height,
    left: Math.round((viewport.width - width) / 2),
    scale,
    top: Math.round((viewport.height - height) / 2),
    width,
  };
}

export function createCanvasRenderer(canvas: HTMLCanvasElement): CanvasRenderer {
  const context = canvas.getContext("2d");
  return {
    clear: () => {
      context?.clearRect(0, 0, canvas.width, canvas.height);
    },
    resize: (size) => {
      canvas.width = size.width;
      canvas.height = size.height;
    },
    render: (frame) => {
      context?.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
    },
  };
}
