// Camera HUD state — a tiny bridge from the imperative scene camera (which lives
// in the director, not a store) to the React chrome that draws it (the compass
// minimap's aria-current + the override badge). The scene stays React-free: it
// raises a callback (TableScene.onCameraView), TableCanvas pushes it here, and the
// HUD reads it like any other store. Ephemeral view state, so — like the hover
// store — it lives outside the design-§4 protocol store table.

import { createStore } from 'zustand/vanilla';
import type { CameraView } from '../camera/camera';

export interface CameraHudState {
  /** Where the lens points: the whole table or a display seat. */
  view: CameraView;
  /** True while the camera auto-follows the active player (no manual override). */
  following: boolean;
}

export const cameraHudStore = createStore<CameraHudState>(() => ({
  view: { kind: 'table' },
  following: true,
}));

export const setCameraHud = (view: CameraView, following: boolean): void =>
  cameraHudStore.setState({ view, following });
