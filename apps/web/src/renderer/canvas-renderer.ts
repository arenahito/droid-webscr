export interface CanvasRenderer {
  clear(): void;
  render(frame: VideoFrame): void;
}

export function createCanvasRenderer(canvas: HTMLCanvasElement): CanvasRenderer {
  const context = canvas.getContext("2d");
  return {
    clear: () => {
      context?.clearRect(0, 0, canvas.width, canvas.height);
    },
    render: (frame) => {
      context?.drawImage(frame, 0, 0, canvas.width, canvas.height);
    },
  };
}
