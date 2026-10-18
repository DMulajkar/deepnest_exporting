/**
 * Cut-order optimization for DeepNest
 * Reorders paths so the tool travels less between cuts. Pure functions with no
 * DOM or Electron dependencies so they can be tested on their own.
 *
 * Greedy nearest-neighbour: from the current tool position, take the closest
 * path entry point next. Closed paths may start at any of their vertices and
 * open paths may be cut in either direction. A closed path that contains other
 * closed paths (a part outline around its holes) is never cut before them, so a
 * cut-out part is not freed while its holes are still to be cut.
 *
 * A local search (2-opt and Or-opt) then improves the greedy result: it reverses
 * or relocates runs of cuts wherever that shortens travel, without breaking the
 * holes-first rule. See improveTour.
 */

import type { HpglPath } from "./hpgl.js";

interface Point {
  x: number;
  y: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(points: Point[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    b.minX = Math.min(b.minX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x);
    b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
}

function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Total tool travel (distance moved with the tool off) for cutting the paths in order
 * @param paths - Paths in cutting order
 * @param start - Where the tool starts
 */
export function travelDistance(paths: HpglPath[], start: Point): number {
  let total = 0;
  let at = start;

  for (const path of paths) {
    if (path.points.length < 2) {
      continue;
    }

    const first = path.points[0];
    total += Math.hypot(first.x - at.x, first.y - at.y);
    // a closed path ends back at its first point
    at = path.closed ? first : path.points[path.points.length - 1];
  }

  return total;
}

/**
 * @param paths - Paths in any consistent unit; paths with fewer than 2 points are dropped
 * @param start - Where the tool starts (default: 0,0)
 * @param twoOpt - Run the 2-opt pass after the greedy ordering (default: true)
 * @returns The same paths reordered, with closed paths rotated and open paths possibly reversed
 */
export function optimizePathOrder(
  paths: HpglPath[],
  start: Point = { x: 0, y: 0 },
  twoOpt = true
): HpglPath[] {
  const todo = paths.filter((p) => p.points.length >= 2);
  const bounds = todo.map((p) => boundsOf(p.points));

  // blockers[i] = number of uncut closed paths contained inside closed path i
  const blockers = new Array<number>(todo.length).fill(0);
  const containedBy: number[][] = todo.map(() => []);

  todo.forEach((outer, i) => {
    if (!outer.closed) {
      return;
    }
    todo.forEach((inner, j) => {
      if (i === j || !inner.closed) {
        return;
      }
      const bo = bounds[i];
      const bi = bounds[j];
      if (bi.minX < bo.minX || bi.maxX > bo.maxX || bi.minY < bo.minY || bi.maxY > bo.maxY) {
        return;
      }
      if (pointInPolygon(inner.points[0], outer.points)) {
        blockers[i]++;
        containedBy[j].push(i);
      }
    });
  });

  const done = new Array<boolean>(todo.length).fill(false);
  // greedy tour: path indices in cutting order, and each path's points as entered
  const tour: number[] = [];
  const pts: Point[][] = [];
  let at = start;

  for (let step = 0; step < todo.length; step++) {
    let best = -1;
    let bestDistance = Infinity;
    let bestIndex = 0;
    let bestReverse = false;

    // First pass respects containment. If nothing is free (identical duplicate polygons
    // can each count as containing the other), the second pass ignores it.
    for (const strict of [true, false]) {
      for (let i = 0; i < todo.length; i++) {
        if (done[i] || (strict && blockers[i] > 0)) {
          continue;
        }

        const { points, closed } = todo[i];
        if (closed) {
          points.forEach((p, k) => {
            const d = Math.hypot(p.x - at.x, p.y - at.y);
            if (d < bestDistance) {
              best = i;
              bestDistance = d;
              bestIndex = k;
              bestReverse = false;
            }
          });
        } else {
          const first = points[0];
          const last = points[points.length - 1];
          const dFirst = Math.hypot(first.x - at.x, first.y - at.y);
          const dLast = Math.hypot(last.x - at.x, last.y - at.y);
          const d = Math.min(dFirst, dLast);
          if (d < bestDistance) {
            best = i;
            bestDistance = d;
            bestIndex = 0;
            bestReverse = dLast < dFirst;
          }
        }
      }

      if (best >= 0) {
        break;
      }
    }

    const { points, closed } = todo[best];
    const ordered = closed
      ? [...points.slice(bestIndex), ...points.slice(0, bestIndex)]
      : bestReverse
        ? [...points].reverse()
        : points;

    tour.push(best);
    pts[best] = ordered;
    done[best] = true;
    containedBy[best].forEach((outer) => {
      blockers[outer]--;
    });
    at = closed ? ordered[0] : ordered[ordered.length - 1];
  }

  const flipped = twoOpt ? improveTour(todo, pts, containedBy, tour, start) : new Set<number>();

  return tour.map((id) => {
    const { closed } = todo[id];
    return { points: flipped.has(id) ? [...pts[id]].reverse() : pts[id], closed };
  });
}

/**
 * Cap on candidate moves examined, so a large nest cannot stall the UI.
 * Deterministic: the same input always gives the same order.
 */
const MAX_EVALUATIONS = 1_500_000;

/** Longest run of cuts Or-opt will relocate */
const MAX_OR_OPT_RUN = 3;

/**
 * Local search over the greedy tour, repeated until no move helps or the budget is spent:
 * - 2-opt: reverse a run of consecutive cuts when that shortens tool travel. Reversing a run
 *   also reverses the open paths inside it (closed paths enter and leave at the same vertex).
 * - Or-opt: move a run of 1-3 cuts elsewhere, keeping their direction.
 * Both skip any move that would put a closed path before a path it contains. A part with holes
 * sits in the tour as hole(s) then outline, which blocks most reversals, so Or-opt does most
 * of the work on nests with holes.
 * Reorders `tour` in place.
 * @returns Ids of open paths that now run in reverse of how `pts` stores them
 */
function improveTour(
  todo: HpglPath[],
  pts: Point[][],
  containedBy: number[][],
  tour: number[],
  start: Point
): Set<number> {
  const flipped = new Set<number>();
  const n = tour.length;
  const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
  const entryOf = (id: number): Point =>
    flipped.has(id) ? pts[id][pts[id].length - 1] : pts[id][0];
  const exitOf = (id: number): Point => {
    const p = pts[id];
    if (todo[id].closed) {
      return p[0];
    }
    return flipped.has(id) ? p[0] : p[p.length - 1];
  };

  // containedBy[x] = paths containing x (must come after x); inners[x] = paths x contains
  const inners: number[][] = todo.map(() => []);
  containedBy.forEach((outers, inner) => outers.forEach((outer) => inners[outer].push(inner)));

  const pos = new Array<number>(todo.length);
  const indexTour = (): void => {
    tour.forEach((id, k) => {
      pos[id] = k;
    });
  };
  indexTour();

  // Would reversing tour[from..to] put a path after one that must come after it?
  const reversalBreaksContainment = (from: number, to: number): boolean => {
    for (let k = from; k <= to; k++) {
      for (const outer of containedBy[tour[k]]) {
        if (pos[outer] >= from && pos[outer] <= to) {
          return true;
        }
      }
    }
    return false;
  };

  // Would moving tour[from..to] to just after tour[after] break the containment order?
  const moveBreaksContainment = (from: number, to: number, after: number): boolean => {
    for (let k = from; k <= to; k++) {
      for (const outer of containedBy[tour[k]]) {
        if ((pos[outer] < from || pos[outer] > to) && pos[outer] <= after) {
          return true;
        }
      }
      for (const inner of inners[tour[k]]) {
        if ((pos[inner] < from || pos[inner] > to) && pos[inner] > after) {
          return true;
        }
      }
    }
    return false;
  };

  let evaluations = 0;

  const twoOptSweep = (): boolean => {
    let improved = false;

    // i is the position just before the reversed run (-1 = the start point)
    for (let i = -1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        if (++evaluations > MAX_EVALUATIONS) {
          return improved;
        }

        const first = tour[i + 1];
        const last = tour[j];
        if (j === i + 1 && todo[first].closed) {
          continue;
        }

        const before = i < 0 ? start : exitOf(tour[i]);
        const next = j + 1 < n ? entryOf(tour[j + 1]) : null;

        const oldCost = dist(before, entryOf(first)) + (next ? dist(exitOf(last), next) : 0);
        const newCost = dist(before, exitOf(last)) + (next ? dist(entryOf(first), next) : 0);

        if (newCost < oldCost - 1e-9 && !reversalBreaksContainment(i + 1, j)) {
          tour.splice(i + 1, j - i, ...tour.slice(i + 1, j + 1).reverse());
          for (let k = i + 1; k <= j; k++) {
            const id = tour[k];
            if (!todo[id].closed) {
              if (flipped.has(id)) {
                flipped.delete(id);
              } else {
                flipped.add(id);
              }
            }
          }
          indexTour();
          improved = true;
        }
      }
    }

    return improved;
  };

  const orOptSweep = (): boolean => {
    let improved = false;

    for (let len = 1; len <= MAX_OR_OPT_RUN; len++) {
      for (let i = 0; i + len <= n; i++) {
        const j = i + len - 1;
        const segEntry = entryOf(tour[i]);
        const segExit = exitOf(tour[j]);
        const prevExit = i === 0 ? start : exitOf(tour[i - 1]);
        const next = j + 1 < n ? entryOf(tour[j + 1]) : null;

        // travel saved by taking the run out of the tour
        const removeGain =
          dist(prevExit, segEntry) +
          (next ? dist(segExit, next) - dist(prevExit, next) : 0);
        if (removeGain <= 1e-9) {
          continue;
        }

        // p = position the run is inserted after (-1 = right after the start point)
        for (let p = -1; p < n; p++) {
          if (p >= i - 1 && p <= j) {
            continue;
          }
          if (++evaluations > MAX_EVALUATIONS) {
            return improved;
          }

          const a = p < 0 ? start : exitOf(tour[p]);
          const b = p + 1 < n ? entryOf(tour[p + 1]) : null;
          const addCost = dist(a, segEntry) + (b ? dist(segExit, b) - dist(a, b) : 0);

          if (addCost < removeGain - 1e-9 && !moveBreaksContainment(i, j, p)) {
            const run = tour.splice(i, len);
            tour.splice(p < i ? p + 1 : p + 1 - len, 0, ...run);
            indexTour();
            improved = true;
            break;
          }
        }
      }
    }

    return improved;
  };

  while (evaluations <= MAX_EVALUATIONS) {
    // non-short-circuit: run both neighbourhoods every round
    const changed = [twoOptSweep(), orOptSweep()].some(Boolean);
    if (!changed) {
      break;
    }
  }

  return flipped;
}
