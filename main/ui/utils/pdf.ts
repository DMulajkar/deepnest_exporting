/**
 * Minimal vector PDF generation for DeepNest
 * Draws polylines as stroked paths on a single page. Pure functions with no DOM
 * or Electron dependencies so they can be tested on their own.
 *
 * Output is plain ASCII, so string length equals byte length and the xref
 * offsets below can be computed from string lengths.
 */

import type { HpglPath } from "./hpgl.js";

const POINTS_PER_INCH = 72;

export interface PdfOptions {
  /** Stroke width in points (default: 0.5) */
  lineWidth?: number;
}

function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * @param paths - Paths in inches, y pointing up (PDF's origin is also bottom-left)
 * @param widthInches - Page width in inches
 * @param heightInches - Page height in inches
 */
export function generatePdf(
  paths: HpglPath[],
  widthInches: number,
  heightInches: number,
  options: PdfOptions = {}
): string {
  const lineWidth = options.lineWidth ?? 0.5;

  const ops: string[] = [`${num(lineWidth)} w`];
  for (const path of paths) {
    if (path.points.length < 2) {
      continue;
    }

    path.points.forEach((p, i) => {
      ops.push(`${num(p.x * POINTS_PER_INCH)} ${num(p.y * POINTS_PER_INCH)} ${i === 0 ? "m" : "l"}`);
    });
    ops.push(path.closed ? "h S" : "S");
  }
  const content = ops.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(widthInches * POINTS_PER_INCH)} ${num(heightInches * POINTS_PER_INCH)}] /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return pdf;
}
