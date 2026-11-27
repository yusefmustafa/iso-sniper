import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { loopbackPair } from '../src/net/channel';
import { decodeCommand, encodeCommand } from '../src/net/codec';
import { RollbackSession } from '../src/net/rollback';
import { datan2, dcos, dsin } from '../src/sim/dmath';
import { createGame, step } from '../src/sim/sim';
import { emptyCommand, type Command, type GameState } from '../src/sim/types';

/** Deterministic pseudo-random input script for player `p` on frame `f`. */
function scripted(p: number, f: number, s: GameState): Command {
  const c = emptyCommand();
  const phase = Math.floor(f / 23) + p * 7;
  const me = s.players[p], other = s.players[1 - p];
  c.moveX = [1, 0, -1, 0.5, 0][phase % 5];
  c.moveZ = [0, 1, 0.3, -1, 0][(phase * 3) % 5];
  c.aimActive = true;
  c.aim = Math.atan2(other.z - me.z, other.x - me.x) + ((f % 17) - 8) * 0.01;
  c.ads = phase % 3 !== 0;
  c.fire = f % 41 < 3;
  c.roll = f % 97 < 2;
  c.sprint = phase % 4 === 1;
  c.start = f % 300 < 2;
  return c;
}

function runNetworked(opts: { latencyMs: number; jitterMs?: number; loss?: number; frames: number; seed?: number }) {
  let r = 1;
  const random = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const link = loopbackPair({ ...opts, random });
  const clock = () => link.now;
  const a = new RollbackSession(createGame({ seed: opts.seed ?? 7 }), 0, link.a, config, { clock });
  const b = new RollbackSession(createGame({ seed: opts.seed ?? 7 }), 1, link.b, config, { clock });
  const frameMs = 1000 / 60;
  for (let i = 0; i < opts.frames; i++) {
    a.tick(scripted(0, a.frame, a.state));
    b.tick(scripted(1, b.frame, b.state));
    link.advance(frameMs);
  }
  // Let the last inputs arrive, then stop feeding new frames until both have caught up.
  return { a, b, link };
}

describe('deterministic math', () => {
  it('dsin/dcos/datan2 match Math within 1e-14', () => {
    for (let x = -20; x <= 20; x += 0.0137) {
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-14);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-14);
    }
    for (let y = -3; y <= 3; y += 0.113) for (let x = -3; x <= 3; x += 0.097) {
      expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-14);
    }
  });
});

describe('wire codec', () => {
  it('quantized commands round-trip exactly', () => {
    const c = { ...emptyCommand(), moveX: 0.37, moveZ: -1, aim: -2.5, aimActive: true, ads: true, fire: true, start: true };
    const once = decodeCommand(encodeCommand(c));
    expect(decodeCommand(encodeCommand(once))).toEqual(once);
    expect(once.fire && once.ads && once.start && !once.roll).toBe(true);
  });

  it('never puts -0 on the wire (JSON would turn it into 0 on the other peer only)', () => {
    const w = encodeCommand({ ...emptyCommand(), moveX: -0, moveZ: -0.001, aim: -0 });
    for (const v of w) expect(Object.is(v, -0)).toBe(false);
  });
});

describe('rollback session', () => {
  it('two peers with 80 ms latency, jitter and 10% loss stay in sync', () => {
    const { a, b } = runNetworked({ latencyMs: 80, jitterMs: 20, loss: 0.1, frames: 2400 });
    expect(a.stats.desyncFrame).toBeNull();
    expect(b.stats.desyncFrame).toBeNull();
    expect(a.stats.rttMs).toBeGreaterThan(120);
    expect(a.stats.rttMs).toBeLessThan(220);
    expect(Math.abs(a.frame - b.frame)).toBeLessThan(10);
    expect(a.frame).toBeGreaterThan(2000);
  });

  it('both peers hash identical confirmed states', () => {
    const { a, b, link } = runNetworked({ latencyMs: 50, jitterMs: 10, frames: 900, seed: 3 });
    // Drain: keep ticking with idle input until both have every remote input.
    for (let i = 0; i < 60; i++) { a.tick(emptyCommand()); b.tick(emptyCommand()); link.advance(1000 / 60); }
    const ha = a.hashes.local, hb = b.hashes.local;
    const common = [...ha.keys()].filter((k) => hb.has(k));
    expect(common.length).toBeGreaterThan(5);
    for (const k of common) expect(ha.get(k)).toBe(hb.get(k));
    expect(a.stats.desyncFrame).toBeNull();
  });

  it('the shooter sees their own shot instantly, and the hit is the same on both peers', () => {
    // A stands still and fires an aimed shot at B, who is also standing still.
    const link = loopbackPair({ latencyMs: 60 });
    const clock = () => link.now;
    const mk = (id: number) => { const g = createGame({ seed: 1 }); g.arena.boxes = []; return new RollbackSession(g, id, id ? link.b : link.a, config, { clock }); };
    const a = mk(0), b = mk(1);
    const countdown = config.countdownTime * 60 + 5;
    const aim = (s: GameState) => Math.atan2(s.players[1].z - s.players[0].z, s.players[1].x - s.players[0].x);
    let shotFrameA = -1;
    for (let i = 0; i < countdown + 120; i++) {
      const fire = a.frame >= countdown + 20 && a.frame < countdown + 23;
      const evA = a.tick({ ...emptyCommand(), aimActive: true, aim: aim(a.state), ads: true, fire });
      b.tick({ ...emptyCommand(), aimActive: true, aim: Math.PI });
      if (shotFrameA < 0 && evA.some((e) => e.type === 'shot')) shotFrameA = a.frame;
      link.advance(1000 / 60);
    }
    // Only the 2-frame input delay between pressing and seeing the shot locally.
    expect(shotFrameA).toBeLessThanOrEqual(countdown + 20 + 3);
    expect(a.state.players[1].hp).toBe(2);
    expect(b.state.players[1].hp).toBe(2);
  });
});

describe('sim', () => {
  it('a start press at match end restarts the match through the sim', () => {
    const g = createGame();
    g.phase = 'matchEnd';
    g.score = [3, 1];
    step(g, [{ ...emptyCommand(), start: true }, emptyCommand()]);
    expect(g.phase).toBe('countdown');
    expect(g.score).toEqual([0, 0]);
  });
});
