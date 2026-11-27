import { config } from '../config';
import { chargeTicksFor, gunUp, isCharged } from '../sim/sim';
import type { GameState } from '../sim/types';
import { AIM_HEIGHT, PLAYER_COLORS } from './scene';

const DEG = Math.PI / 180;
const PAD_REACH = 7; // meters: cone length for players aiming with a stick
const MIN_REACH = 1.5;

type ToScreen = (x: number, y: number, z: number) => { x: number; y: number };
type ToWorld = (x: number, y: number) => { x: number; z: number } | null;

export interface AimSource {
  /** Screen position of this player's mouse, or null for a gamepad. */
  mouse: { x: number; y: number } | null;
}

/**
 * The aim cursor, drawn on a 2D overlay. Hip-fire shows the real spread cone
 * (every hip shot lands inside it), projected from the ground so it skews with
 * the camera. Holding focus closes the cone into a crosshair, and a ring around
 * the crosshair fills as the shot charges.
 */
export class AimCursor {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private open: number[] = [1, 1]; // 1 = hip cone, 0 = crosshair (smoothed)
  private dpr = 1;

  constructor(before: Element) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'aim-cursor';
    before.parentElement!.insertBefore(this.canvas, before);
    this.g = this.canvas.getContext('2d')!;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * this.dpr);
    this.canvas.height = Math.round(window.innerHeight * this.dpr);
  }

  clear() {
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(state: GameState, positions: { x: number; z: number }[], sources: (AimSource | null)[], toScreen: ToScreen, toWorld: ToWorld, dt: number) {
    this.clear();
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const k = 1 - Math.exp(-18 * dt);

    state.players.forEach((p, i) => {
      const src = sources[i];
      if (!src || p.dummy || p.hp <= 0) return;
      this.open[i] += ((p.ads ? 0 : 1) - this.open[i]) * k;
      const open = this.open[i];
      const pos = positions[i];

      let reach = PAD_REACH;
      if (src.mouse) {
        const w = toWorld(src.mouse.x, src.mouse.y);
        if (w) reach = Math.max(MIN_REACH, Math.hypot(w.x - pos.x, w.z - pos.z));
      }
      const at = (ang: number, dist: number) =>
        toScreen(pos.x + Math.cos(ang) * dist, AIM_HEIGHT, pos.z + Math.sin(ang) * dist);

      const color = `#${PLAYER_COLORS[i].toString(16).padStart(6, '0')}`;
      const ready = gunUp(p) && p.boltTicks === 0 && state.phase !== 'countdown';
      const alpha = ready ? 1 : 0.35;
      const half = (config.hipSpreadDeg / 2) * DEG * open;
      const start = 0.7; // start the cone just past the muzzle

      // Cone: two edges and an arc at the cursor's distance.
      if (open > 0.02) {
        const steps = 12;
        g.beginPath();
        const a = at(p.aim - half, start);
        g.moveTo(a.x, a.y);
        for (let s = 0; s <= steps; s++) {
          const q = at(p.aim - half + (2 * half * s) / steps, reach);
          g.lineTo(q.x, q.y);
        }
        const b = at(p.aim + half, start);
        g.lineTo(b.x, b.y);
        g.closePath();
        g.globalAlpha = 0.12 * alpha * open;
        g.fillStyle = color;
        g.fill();
        g.globalAlpha = 0.75 * alpha * Math.max(0.3, open);
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.stroke();
      }

      // Crosshair at the cursor: grows in as the cone closes.
      const c = at(p.aim, reach);
      const closed = 1 - open;
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.fillStyle = color;
      g.lineWidth = 2;
      const gap = 4 + open * 6, len = 4 + closed * 6;
      g.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        g.moveTo(c.x + dx * gap, c.y + dy * gap);
        g.lineTo(c.x + dx * (gap + len * (0.4 + 0.6 * closed)), c.y + dy * (gap + len * (0.4 + 0.6 * closed)));
      }
      g.stroke();
      g.beginPath();
      g.arc(c.x, c.y, 1.8, 0, Math.PI * 2);
      g.fill();

      // Charge ring around the crosshair while focusing.
      if (p.ads && closed > 0.3) {
        const frac = Math.min(1, p.adsTicks / chargeTicksFor(p));
        const r = 15;
        g.globalAlpha = 0.25 * alpha;
        g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = alpha;
        g.strokeStyle = isCharged(p) ? '#ffffff' : color;
        g.lineWidth = isCharged(p) ? 3 : 2;
        g.beginPath(); g.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); g.stroke();
      }
      g.globalAlpha = 1;
    });
  }
}
