/**
 * Toolpath Animator
 * Full-window overlay that replays the laser/tool moves of a nest on a canvas:
 * a glowing dot follows the path, cuts light up behind it, rapids show as dashes.
 * Move order and timing come from utils/toolpath.ts (same order as the G-code export).
 */

import type { HpglPath } from "../utils/hpgl.js";
import { buildToolpath, positionAt, segmentIndexAt } from "../utils/toolpath.js";
import type { Toolpath } from "../utils/toolpath.js";

/** Seconds the whole animation takes at 1x speed */
const BASE_SECONDS = 15;

/** Length of the hot trail behind the tool, as a fraction of the total duration */
const TRAIL_FRACTION = 0.01;

const SPEEDS = [0.5, 1, 2, 4, 8];

export interface ToolpathData {
  /** Paths in inches, y pointing up */
  paths: HpglPath[];
  widthInches: number;
  heightInches: number;
}

export class ToolpathAnimator {
  private overlay: HTMLDivElement | null = null;
  private canvas!: HTMLCanvasElement;
  private playBtn!: HTMLButtonElement;
  private scrub!: HTMLInputElement;
  private label!: HTMLSpanElement;
  private speedSelect!: HTMLSelectElement;

  private toolpath: Toolpath = { segments: [], duration: 0 };
  private widthInches = 1;
  private heightInches = 1;

  /** Current position on the toolpath's time axis */
  private t = 0;
  private playing = false;
  private speed = 1;
  private lastFrame = 0;
  private frameId = 0;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      this.close();
    } else if (e.key === " ") {
      e.preventDefault();
      this.togglePlay();
    }
  };

  private readonly onResize = (): void => this.draw();

  /**
   * Open the overlay and start playing
   * @param data - Paths in inches (y up) and the page size
   */
  open(data: ToolpathData): void {
    this.close();

    this.toolpath = buildToolpath(data.paths);
    this.widthInches = data.widthInches;
    this.heightInches = data.heightInches;
    this.t = 0;
    this.speed = 1;

    this.build();
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("resize", this.onResize);
    this.draw();
    this.play();
  }

  close(): void {
    this.pause();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("resize", this.onResize);
    this.overlay?.remove();
    this.overlay = null;
  }

  private build(): void {
    const overlay = document.createElement("div");
    overlay.className = "toolpath-overlay";
    overlay.innerHTML = `
      <div class="toolpath-header">
        <span class="toolpath-title">Laser path preview</span>
        <span class="toolpath-legend">
          <i class="toolpath-key toolpath-key-cut"></i>cut
          <i class="toolpath-key toolpath-key-rapid"></i>travel
        </span>
        <span class="toolpath-close" title="Close (Esc)">&times;</span>
      </div>
      <canvas class="toolpath-canvas"></canvas>
      <div class="toolpath-controls">
        <button class="button toolpath-play">Pause</button>
        <button class="button toolpath-restart">Restart</button>
        <input class="toolpath-scrub" type="range" min="0" max="1000" value="0" />
        <span class="toolpath-label">0%</span>
        <select class="toolpath-speed">
          ${SPEEDS.map((s) => `<option value="${s}"${s === 1 ? " selected" : ""}>${s}x</option>`).join("")}
        </select>
      </div>`;

    this.canvas = overlay.querySelector(".toolpath-canvas") as HTMLCanvasElement;
    this.playBtn = overlay.querySelector(".toolpath-play") as HTMLButtonElement;
    this.scrub = overlay.querySelector(".toolpath-scrub") as HTMLInputElement;
    this.label = overlay.querySelector(".toolpath-label") as HTMLSpanElement;
    this.speedSelect = overlay.querySelector(".toolpath-speed") as HTMLSelectElement;

    (overlay.querySelector(".toolpath-close") as HTMLElement).onclick = () => this.close();
    this.playBtn.onclick = () => this.togglePlay();
    (overlay.querySelector(".toolpath-restart") as HTMLElement).onclick = () => {
      this.t = 0;
      this.play();
    };
    this.scrub.oninput = () => {
      this.t = (Number(this.scrub.value) / 1000) * this.toolpath.duration;
      this.pause();
      this.draw();
    };
    this.speedSelect.onchange = () => {
      this.speed = Number(this.speedSelect.value);
    };

    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  private togglePlay(): void {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  private play(): void {
    if (this.t >= this.toolpath.duration) {
      this.t = 0;
    }
    this.playing = true;
    this.lastFrame = performance.now();
    this.playBtn.textContent = "Pause";
    cancelAnimationFrame(this.frameId);
    this.frameId = requestAnimationFrame(this.tick);
  }

  private pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.frameId);
    if (this.playBtn) {
      this.playBtn.textContent = this.t >= this.toolpath.duration ? "Replay" : "Play";
    }
  }

  private readonly tick = (now: number): void => {
    const { duration } = this.toolpath;
    this.t += ((now - this.lastFrame) / 1000) * this.speed * (duration / BASE_SECONDS);
    this.lastFrame = now;

    if (this.t >= duration) {
      this.t = duration;
      this.draw();
      this.pause();
      return;
    }

    this.draw();
    this.frameId = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    if (!this.overlay) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
    }

    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Fit the page into the canvas with a margin, y flipped so the design is upright
    const margin = 24;
    const scale = Math.min(
      (cssW - 2 * margin) / this.widthInches,
      (cssH - 2 * margin) / this.heightInches
    );
    const offX = (cssW - this.widthInches * scale) / 2;
    const offY = (cssH + this.heightInches * scale) / 2;
    const sx = (x: number): number => offX + x * scale;
    const sy = (y: number): number => offY - y * scale;

    const { segments, duration } = this.toolpath;
    const active = segmentIndexAt(this.toolpath, this.t);
    const style = getComputedStyle(this.overlay);
    const cutColor = style.getPropertyValue("--toolpath-cut").trim() || "#24c7ed";
    const hotColor = style.getPropertyValue("--toolpath-hot").trim() || "#ff7a3d";

    // Page outline
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx(0), sy(this.heightInches), this.widthInches * scale, this.heightInches * scale);

    // Whole toolpath, dim: cuts solid, rapids dashed
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    segments.forEach((s) => {
      if (s.cut) {
        ctx.moveTo(sx(s.x0), sy(s.y0));
        ctx.lineTo(sx(s.x1), sy(s.y1));
      }
    });
    ctx.stroke();

    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath();
    segments.forEach((s) => {
      if (!s.cut) {
        ctx.moveTo(sx(s.x0), sy(s.y0));
        ctx.lineTo(sx(s.x1), sy(s.y1));
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);

    const pos = positionAt(this.toolpath, this.t);

    if (active >= 0) {
      // Finished cuts light up
      ctx.strokeStyle = cutColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < active; i++) {
        const s = segments[i];
        if (s.cut) {
          ctx.moveTo(sx(s.x0), sy(s.y0));
          ctx.lineTo(sx(s.x1), sy(s.y1));
        }
      }
      const cur = segments[active];
      if (cur.cut) {
        ctx.moveTo(sx(cur.x0), sy(cur.y0));
        ctx.lineTo(sx(pos.x), sy(pos.y));
      }
      ctx.stroke();

      // Hot trail just behind the tool
      const trailStart = this.t - duration * TRAIL_FRACTION;
      ctx.strokeStyle = hotColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = active; i >= 0 && segments[i].t1 > trailStart; i--) {
        const s = segments[i];
        if (!s.cut) {
          continue;
        }
        const x1 = i === active ? pos.x : s.x1;
        const y1 = i === active ? pos.y : s.y1;
        ctx.moveTo(sx(s.x0), sy(s.y0));
        ctx.lineTo(sx(x1), sy(y1));
      }
      ctx.stroke();

      // Travel move in progress
      if (!cur.cut) {
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx(cur.x0), sy(cur.y0));
        ctx.lineTo(sx(pos.x), sy(pos.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // The laser: soft glow plus bright core
    const cutting = active >= 0 && segments[active].cut && this.t < duration;
    const glow = ctx.createRadialGradient(sx(pos.x), sy(pos.y), 0, sx(pos.x), sy(pos.y), cutting ? 18 : 12);
    glow.addColorStop(0, cutting ? "rgba(255,160,100,0.95)" : "rgba(255,255,255,0.7)");
    glow.addColorStop(1, "rgba(255,122,61,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sx(pos.x), sy(pos.y), cutting ? 18 : 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(sx(pos.x), sy(pos.y), 2.5, 0, Math.PI * 2);
    ctx.fill();

    const fraction = duration > 0 ? this.t / duration : 0;
    this.scrub.value = String(Math.round(fraction * 1000));
    this.label.textContent = `${Math.round(fraction * 100)}%`;
  }
}

/**
 * Create a toolpath animator
 */
export function createToolpathAnimator(): ToolpathAnimator {
  return new ToolpathAnimator();
}
