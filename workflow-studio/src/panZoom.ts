export interface PanZoomState {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const ZOOM_STEP = 1.2;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function identityTransform(): PanZoomState {
  return { scale: 1, x: 0, y: 0 };
}

export function zoomBy(state: PanZoomState, factor: number): PanZoomState {
  return { ...state, scale: clampScale(state.scale * factor) };
}

/** Zoom so that the world point under (cx, cy) stays under the cursor. */
export function zoomAtPoint(
  state: PanZoomState,
  factor: number,
  cx: number,
  cy: number,
): PanZoomState {
  const nextScale = clampScale(state.scale * factor);
  if (nextScale === state.scale) {
    return state;
  }
  const worldX = (cx - state.x) / state.scale;
  const worldY = (cy - state.y) / state.scale;
  return {
    scale: nextScale,
    x: cx - worldX * nextScale,
    y: cy - worldY * nextScale,
  };
}

export function panBy(state: PanZoomState, dx: number, dy: number): PanZoomState {
  return { ...state, x: state.x + dx, y: state.y + dy };
}

/** Fit content into the viewport box with padding; centers the content. */
export function fit(
  viewport: Size,
  content: Size,
  padding = 16,
): PanZoomState {
  const vw = Math.max(1, viewport.width - padding * 2);
  const vh = Math.max(1, viewport.height - padding * 2);
  const cw = Math.max(1, content.width);
  const ch = Math.max(1, content.height);
  const scale = clampScale(Math.min(vw / cw, vh / ch, 1));
  const x = (viewport.width - cw * scale) / 2;
  const y = (viewport.height - ch * scale) / 2;
  return { scale, x, y };
}

export function toCssTransform(state: PanZoomState): string {
  return `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
}
