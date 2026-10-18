/**
 * G-code generation utilities for DeepNest
 * Turns polylines into a G-code program (millimeters, absolute moves). Pure
 * functions with no DOM or Electron dependencies so they can be tested on their own.
 *
 * Each path is one rapid move (G0) to its start, the tool-on command, cutting
 * moves (G1) along the path, then the tool-off command. The tool commands are
 * options so the same output works for lasers (M3/M5) and for Z-axis machines
 * (e.g. toolOn "G1 Z-1", toolOff "G0 Z5").
 */

import type { HpglPath } from "./hpgl.js";

const MM_PER_INCH = 25.4;

export interface GcodeOptions {
  /** Cutting feed rate in mm/min (default: 1000) */
  feedRate?: number;
  /** Command that starts cutting (default: "M3 S1000", laser on) */
  toolOn?: string;
  /** Command that stops cutting (default: "M5", laser off) */
  toolOff?: string;
}

function mm(inches: number): string {
  return String(Math.round(inches * MM_PER_INCH * 1000) / 1000);
}

/**
 * @param paths - Paths in inches, y pointing up
 */
export function generateGcode(paths: HpglPath[], options: GcodeOptions = {}): string {
  const feedRate = options.feedRate ?? 1000;
  const toolOn = options.toolOn ?? "M3 S1000";
  const toolOff = options.toolOff ?? "M5";

  const lines: string[] = ["G21", "G90", toolOff];

  for (const path of paths) {
    if (path.points.length < 2) {
      continue;
    }

    const points = path.closed ? [...path.points, path.points[0]] : path.points;

    lines.push(`G0 X${mm(points[0].x)} Y${mm(points[0].y)}`);
    lines.push(toolOn);
    points.slice(1).forEach((p, i) => {
      lines.push(`G1 X${mm(p.x)} Y${mm(p.y)}${i === 0 ? ` F${feedRate}` : ""}`);
    });
    lines.push(toolOff);
  }

  lines.push("M2");

  return lines.join("\n") + "\n";
}
