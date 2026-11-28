import { datan2 } from './dmath';
import type { Arena, Box } from './types';

/**
 * Spawn points for a match of `players`. A duel starts on the left and right
 * edges; three or four players start in the corners, the first two diagonally
 * opposite, every one facing the middle.
 */
export function spawnsFor(players: number): Arena['spawns'] {
  if (players <= 2) return [{ x: -16, z: 0, aim: 0 }, { x: 16, z: 0, aim: Math.PI }];
  const corners = [[-16, -9], [16, 9], [16, -9], [-16, 9]];
  return corners.slice(0, players).map(([x, z]) => ({ x, z, aim: datan2(-z, -x) }));
}

/** A 40 x 25 m arena, symmetric under a 180 degree rotation so neither spawn is favored. */
export function defaultArena(players = 2): Arena {
  const h = 1.4;
  const boxes: Box[] = [
    { x: 0, z: 0, w: 2.5, d: 2.5, h },
    { x: -9, z: -5, w: 2, d: 4, h },
    { x: 9, z: 5, w: 2, d: 4, h },
    { x: -9, z: 6, w: 4, d: 1.5, h },
    { x: 9, z: -6, w: 4, d: 1.5, h },
    { x: 0, z: -9, w: 6, d: 1.2, h },
    { x: 0, z: 9, w: 6, d: 1.2, h },
    { x: -14, z: -9, w: 2, d: 2, h },
    { x: 14, z: 9, w: 2, d: 2, h },
  ];
  return {
    width: 40,
    depth: 25,
    boxes,
    spawns: spawnsFor(players),
  };
}

/** Push a circle out of every box and keep it inside the arena. Mutates p. */
export function resolveCircle(arena: Arena, p: { x: number; z: number }, r: number): void {
  const hx = arena.width / 2 - r;
  const hz = arena.depth / 2 - r;
  for (const b of arena.boxes) {
    const minX = b.x - b.w / 2, maxX = b.x + b.w / 2;
    const minZ = b.z - b.d / 2, maxZ = b.z + b.d / 2;
    const cx = Math.max(minX, Math.min(p.x, maxX));
    const cz = Math.max(minZ, Math.min(p.z, maxZ));
    let dx = p.x - cx, dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * r;
      p.z = cz + (dz / d) * r;
    } else {
      // Center is inside the box: push out along the shallowest axis.
      const pushes = [p.x - minX + r, maxX - p.x + r, p.z - minZ + r, maxZ - p.z + r];
      const m = Math.min(...pushes);
      if (m === pushes[0]) p.x = minX - r;
      else if (m === pushes[1]) p.x = maxX + r;
      else if (m === pushes[2]) p.z = minZ - r;
      else p.z = maxZ + r;
    }
  }
  p.x = Math.max(-hx, Math.min(hx, p.x));
  p.z = Math.max(-hz, Math.min(hz, p.z));
}

/** Distance along a ray (unit dir) to the first box or arena wall. */
export function rayToWorld(arena: Arena, ox: number, oz: number, dx: number, dz: number, maxDist: number): number {
  let best = maxDist;
  const test = (minX: number, maxX: number, minZ: number, maxZ: number) => {
    let tmin = -Infinity, tmax = Infinity;
    if (Math.abs(dx) < 1e-9) { if (ox < minX || ox > maxX) return; }
    else {
      let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    }
    if (Math.abs(dz) < 1e-9) { if (oz < minZ || oz > maxZ) return; }
    else {
      let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    }
    if (tmax < Math.max(tmin, 0)) return;
    const t = tmin >= 0 ? tmin : 0;
    if (t < best) best = t;
  };
  for (const b of arena.boxes) test(b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2);
  // Arena walls: distance to leaving the inner rectangle.
  const hx = arena.width / 2, hz = arena.depth / 2;
  if (dx > 1e-9) best = Math.min(best, (hx - ox) / dx);
  if (dx < -1e-9) best = Math.min(best, (-hx - ox) / dx);
  if (dz > 1e-9) best = Math.min(best, (hz - oz) / dz);
  if (dz < -1e-9) best = Math.min(best, (-hz - oz) / dz);
  return Math.max(0, best);
}

/** Distance along a ray (unit dir) to a circle, or Infinity. */
export function rayToCircle(ox: number, oz: number, dx: number, dz: number, cx: number, cz: number, r: number): number {
  const fx = ox - cx, fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? 0 : Infinity;
}
