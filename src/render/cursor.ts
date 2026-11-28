import { config } from '../config';
import { settings } from '../settings';
import { rayToWorld } from '../sim/arena';
import { chargeProgress, isCharged, secToTicks } from '../sim/sim';
import type { Arena, GameState } from '../sim/types';
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

  private hatchPattern: CanvasPattern | null = null;
  /** Red diagonal stripes for the blocked part of the cone. */
  private hatch(): CanvasPattern {
    if (!this.hatchPattern) {
      const c = document.createElement('canvas');
      c.width = c.height = 10;
      const h = c.getContext('2d')!;
      h.strokeStyle = '#ff4d4d'; h.lineWidth = 2;
      h.beginPath(); h.moveTo(-2, 12); h.lineTo(12, -2); h.moveTo(-2, 2); h.lineTo(2, -2); h.moveTo(8, 12); h.lineTo(12, 8); h.stroke();
      this.hatchPattern = this.g.createPattern(c, 'repeat')!;
    }
    return this.hatchPattern;
  }

  private openArenaCache: { src: Arena; open: Arena } | null = null;
  /** The arena without its cover, for rays that should only stop at the outer walls. */
  private openArena(arena: Arena): Arena {
    if (this.openArenaCache?.src !== arena) this.openArenaCache = { src: arena, open: { ...arena, boxes: [] } };
    return this.openArenaCache.open;
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
      // Always full brightness (dimming made it hard to track); reloading shows as a ring instead.
      const alpha = 1;
      const half = (config.hipSpreadDeg / 2) * DEG * open;
      const start = 0.7; // start the cone just past the muzzle
      // Settings: end the cone at the cursor, or project it the whole way out to the arena edge.
      // Projected, each ray is colored up to where a shot along it would stop; past cover the
      // rest of it is greyed out ("Grey out blocked"), or colored all the way ("Through walls").
      const full = settings.coneLength === 'full';
      const style = settings.coneWalls; // how the part of the cone behind cover is shown
      const blocks = full && style !== 'through';
      const open2 = this.openArena(state.arena);
      let clearPct: number | null = null;

      if (open > 0.02) {
        const steps = full ? 48 : 12;
        const hit: { x: number; y: number }[] = [], far: { x: number; y: number }[] = [];
        const blocked: boolean[] = [];
        let clearRays = 0;
        for (let s = 0; s <= steps; s++) {
          const ang = p.aim - half + (2 * half * s) / steps;
          const dx = Math.cos(ang), dz = Math.sin(ang);
          if (!full) { hit.push(at(ang, reach)); continue; }
          const edge = Math.max(start, rayToWorld(open2, pos.x, pos.z, dx, dz, config.shotRange));
          const stop = blocks ? Math.max(start, Math.min(edge, rayToWorld(state.arena, pos.x, pos.z, dx, dz, config.shotRange))) : edge;
          hit.push(at(ang, stop));
          far.push(at(ang, edge));
          blocked.push(stop < edge - 0.05);
          // "Clear" = this ray gets at least as far as the cursor.
          if (stop >= Math.min(reach, edge) - 0.05) clearRays++;
        }
        if (full) clearPct = Math.round((100 * clearRays) / (steps + 1));
        const a = at(p.aim - half, start), b = at(p.aim + half, start);
        const poly = (pts: { x: number; y: number }[]) => { g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (const q of pts) g.lineTo(q.x, q.y); g.closePath(); };

        // Live part: where a hip shot can actually land.
        poly([a, ...hit, b]);
        g.globalAlpha = (full ? 0.08 : 0.12) * alpha * open;
        g.fillStyle = color;
        g.fill();
        g.globalAlpha = 0.75 * alpha * Math.max(0.3, open);
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.stroke();

        if (blocks) {
          const behind = () => poly([...hit, ...far.slice().reverse()]);
          const sideLines = (c: string, w: number) => {
            g.strokeStyle = c; g.lineWidth = w;
            g.beginPath(); g.moveTo(hit[0].x, hit[0].y); g.lineTo(far[0].x, far[0].y);
            g.moveTo(hit[steps].x, hit[steps].y); g.lineTo(far[steps].x, far[steps].y);
            g.stroke();
          };
          // Where rays hit cover: a bright line along the impact points.
          const impactLine = (c: string, w: number) => {
            g.strokeStyle = c; g.lineWidth = w; g.lineCap = 'round';
            g.beginPath();
            for (let s = 0; s <= steps; s++) {
              if (!blocked[s]) continue;
              if (s === 0 || !blocked[s - 1]) g.moveTo(hit[s].x, hit[s].y); else g.lineTo(hit[s].x, hit[s].y);
              if (s === steps || !blocked[s + 1]) g.lineTo(hit[s].x + 0.01, hit[s].y);
            }
            g.stroke();
            g.lineCap = 'butt';
          };
          if (style === 'stop' || style === 'percent') {
            // A: grey continuation (the earlier look).
            behind(); g.globalAlpha = 0.07 * alpha * open; g.fillStyle = '#9aa1ad'; g.fill();
            g.globalAlpha = 0.35 * alpha * Math.max(0.3, open); sideLines('#9aa1ad', 1);
          } else if (style === 'hatch') {
            // B: red hatching behind cover, plus a red impact line on the cover face.
            behind(); g.globalAlpha = 0.55 * alpha * open; g.fillStyle = this.hatch(); g.fill();
            g.globalAlpha = 0.5 * alpha * Math.max(0.3, open); sideLines('#ff5a5a', 1);
            g.globalAlpha = 0.95 * alpha * Math.max(0.3, open); impactLine('#ff4d4d', 3);
          } else if (style === 'cut') {
            // C: nothing drawn behind cover; the blocked rays end in a hard white-red impact edge.
            g.globalAlpha = alpha * Math.max(0.3, open); impactLine('#ffffff', 4);
            impactLine('#ff3b3b', 2);
          }
        }
      }

      // D: "% clear" readout by the crosshair: how much of the spread gets as far as the cursor.
      if (style === 'percent' && clearPct !== null && open > 0.3) {
        const cp = at(p.aim, reach);
        const t = clearPct / 100;
        g.globalAlpha = alpha * Math.min(1, (open - 0.3) / 0.4);
        g.font = '700 13px system-ui, sans-serif';
        g.textBaseline = 'middle';
        const txt = `${clearPct}% clear`;
        const w = g.measureText(txt).width + 12;
        g.fillStyle = 'rgba(10,12,16,0.7)';
        g.beginPath(); g.roundRect(cp.x + 16, cp.y - 11, w, 22, 6); g.fill();
        g.fillStyle = t > 0.85 ? '#7dff9a' : t > 0.4 ? '#ffcf5c' : '#ff5a5a';
        g.fillText(txt, cp.x + 22, cp.y);
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

      // Empowered-shot charge ring around the crosshair (kneeling only).
      if (p.ads && p.stance === 'kneel' && closed > 0.3) {
        const frac = chargeProgress(p);
        const r = 15;
        g.globalAlpha = 0.25 * alpha;
        g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = alpha;
        g.strokeStyle = isCharged(p) ? '#ffffff' : color;
        g.lineWidth = isCharged(p) ? 3 : 2;
        g.beginPath(); g.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); g.stroke();
      }

      // Reload (bolt cycle): a ring around the crosshair fills clockwise until the next round is chambered.
      if (p.boltTicks > 0) {
        const total = Math.max(1, secToTicks(config.boltTime));
        const frac = 1 - p.boltTicks / total;
        const r = 12;
        g.globalAlpha = 0.9;
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(10,12,16,0.75)';
        g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.stroke();
        g.lineWidth = 2.5;
        g.strokeStyle = '#e8ebf0';
        g.beginPath(); g.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); g.stroke();
      }
      g.globalAlpha = 1;
    });
  }
}
