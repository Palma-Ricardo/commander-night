// Every 2D canvas we upload as a WebGL texture asks for a CPU-backed context.
// Firefox 160 (Linux, NVIDIA 620 driver; seen 2026-11-14) hands a GPU-accelerated
// 2D canvas to texImage2D with red and blue swapped: Islands came out orange and
// the card back came out blue, while everything Pixi draws directly was fine.
// `willReadFrequently` keeps the canvas in software in every engine, which
// sidesteps the GPU→GPU copy. These canvases are drawn once and then cached, so
// the cost of drawing in software doesn't matter.
export const CPU_CANVAS: CanvasRenderingContext2DSettings = { willReadFrequently: true };
