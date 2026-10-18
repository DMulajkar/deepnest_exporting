/**
 * Toolpath timeline utilities for DeepNest
 * Turns polylines into the ordered list of moves a laser/tool makes (rapids to
 * each path start, then cutting moves), with a time axis for animation. Pure
 * functions with no DOM or Electron dependencies so they can be tested on their own.
 *
 * The move order matches generateGcode: paths in order, closed paths return to
 * their start, and the first rapid starts from the machine origin (0,0).
 */

import type { HpglPath } from "./hpgl.js";

export interface ToolSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** True for a cutting move, false for a rapid (tool off) */
  cut: boolean;
  /** Start and end time on the toolpath's time axis */
  t0: number;
  t1: number;
}

export interface Toolpath {
  segments: ToolSegment[];
  /** Total time on the time axis (cutting speed is 1 unit of length per unit of time) */
  duration: number;
}

/**
 * @param paths - Paths in any consistent length unit, y pointing up
 * @param rapidSpeed - How many times faster rapids are than cutting (default: 4)
 */
export function buildToolpath(paths: HpglPath[], rapidSpeed = 4): Toolpath {
  const segments: ToolSegment[] = [];
  let t = 0;
  let x = 0;
  let y = 0;

  const move = (x1: number, y1: number, cut: boolean): void => {
    const length = Math.hypot(x1 - x, y1 - y);
    if (length > 0) {
      const t1 = t + length / (cut ? 1 : rapidSpeed);
      segments.push({ x0: x, y0: y, x1, y1, cut, t0: t, t1 });
      t = t1;
    }
    x = x1;
    y = y1;
  };

  for (const path of paths) {
    if (path.points.length < 2) {
      continue;
    }

    const points = path.closed ? [...path.points, path.points[0]] : path.points;

    move(points[0].x, points[0].y, false);
    for (const p of points.slice(1)) {
      move(p.x, p.y, true);
    }
  }

  return { segments, duration: t };
}

/**
 * Index of the segment active at time t (the last segment for t past the end),
 * or -1 if there are no segments
 */
export function segmentIndexAt(toolpath: Toolpath, t: number): number {
  const { segments } = toolpath;
  let lo = 0;
  let hi = segments.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].t1 < t) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return hi;
}

/** Tool position at time t */
export function positionAt(toolpath: Toolpath, t: number): { x: number; y: number } {
  const i = segmentIndexAt(toolpath, t);
  if (i < 0) {
    return { x: 0, y: 0 };
  }

  const s = toolpath.segments[i];
  const f = s.t1 > s.t0 ? Math.min(Math.max((t - s.t0) / (s.t1 - s.t0), 0), 1) : 1;
  return { x: s.x0 + (s.x1 - s.x0) * f, y: s.y0 + (s.y1 - s.y0) * f };
}
