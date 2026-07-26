// Shared prompt-surface anchoring (prompts-on-the-table §5.3/§5.4): the live
// on-screen rect of the first candidate object that resolves to an actor,
// polled on a short interval — the subject may still be easing under the
// camera flush when the ask arrives, and a fixed read would pin the panel to a
// stale frame. Undefined when nothing resolves (callers fall back to their
// centred/corner position).

import { useEffect, useState } from 'react';
import type { Id } from '@night/core/protocol/protocol';
import { getActiveScene } from '../scene/TableScene';
import type { ScreenAnchor } from '../scene/interaction';

export function useLiveAnchor(candidates: (Id | undefined)[]): ScreenAnchor | undefined {
  const [anchor, setAnchor] = useState<ScreenAnchor | undefined>(undefined);
  const key = candidates.filter(id => id !== undefined).join('|');
  useEffect(() => {
    if (key === '') { setAnchor(undefined); return; }
    const ids = key.split('|');
    const read = (): void => {
      const scene = getActiveScene();
      let a: ScreenAnchor | undefined;
      for (const id of ids) {
        a = scene?.anchorFor(id);
        if (a !== undefined) break;
      }
      setAnchor(prev => sameAnchor(prev, a) ? prev : a);
    };
    read();
    const t = setInterval(read, 200);
    return () => clearInterval(t);
  }, [key]);
  return anchor;
}

function sameAnchor(a: ScreenAnchor | undefined, b: ScreenAnchor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1
    && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}
