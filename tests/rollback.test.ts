import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { decodeCommand, encodeCommand } from '../src/net/codec';
import { loopbackMesh, type LinkOpts } from '../src/net/mesh';
import { RollbackSession, type RollbackOptions } from '../src/net/rollback';
import { datan2, dcos, dsin } from '../src/sim/dmath';
import { createGame, step } from '../src/sim/sim';
import { emptyCommand, type Command, type GameState } from '../src/sim/types';

/** Deterministic pseudo-random input script for player `p` on frame `f`. */
function scripted(p: number, f: number, s: GameState): Command {
  const c = emptyCommand();
  const phase = Math.floor(f / 23) + p * 7;
  const me = s.players[p], other = s.players[(p + 1) % s.players.length];
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

const lcg = (seed: number) => { let r = seed; return () => ((r = (r * 16807) % 2147483647) / 2147483647); };

/** `n` peers in a full mesh, one player each; peer 0 hosts. */
export function mesh(n: number, link: LinkOpts & { random?: () => number }, opts: RollbackOptions = {}, game: () => GameState = () => createGame({ seed: 7, players: n })) {
  const net = loopbackMesh(n, link);
  const clock = () => net.now;
  const sessions = net.meshes.map((m, i) => new RollbackSession(game(), { self: m.selfId, host: net.ids[0], owners: net.ids, local: i }, m, config, { clock, ...opts }));
  return { net, sessions };
}

function runNetworked(opts: { latencyMs: number; jitterMs?: number; loss?: number; frames: number; seed?: number }) {
  const { net: link, sessions: [a, b] } = mesh(2, { ...opts, random: lcg(1) }, {}, () => createGame({ seed: opts.seed ?? 7 }));
  const frameMs = 1000 / 60;
  for (let i = 0; i < opts.frames; i++) {
    a.tick(scripted(0, a.frame, a.state));
    b.tick(scripted(1, b.frame, b.state));
    link.advance(frameMs);
  }
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
    const { net: link, sessions: [a, b] } = mesh(2, { latencyMs: 60 }, { maxInputDelay: 2, maxSelfDelay: 2 }, () => { const g = createGame({ seed: 1 }); g.arena.boxes = []; return g; });
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

describe('input delay and presses', () => {
  it('raises the input delay with the ping and stays in sync', () => {
    const { a, b } = runNetworked({ latencyMs: 110, jitterMs: 10, frames: 900 });
    expect(a.stats.inputDelay).toBe(4);
    expect(b.stats.inputDelay).toBe(4);
    expect(a.stats.desyncFrame).toBeNull();
    const { a: c } = runNetworked({ latencyMs: 20, frames: 600 });
    expect(c.stats.inputDelay).toBe(2);
  });

  it('keeps the delay change in sync when the ping drops mid-match', () => {
    const { net: link, sessions: [a, b] } = mesh(2, { latencyMs: 120 }, { maxInputDelay: 4, maxSelfDelay: 4 }, () => createGame({ seed: 5 }));
    for (let i = 0; i < 1500; i++) {
      if (i === 700) link.setLatency(10);
      a.tick(scripted(0, a.frame, a.state));
      b.tick(scripted(1, b.frame, b.state));
      link.advance(1000 / 60);
    }
    for (let i = 0; i < 60; i++) { a.tick(emptyCommand()); b.tick(emptyCommand()); link.advance(1000 / 60); }
    expect(a.stats.inputDelay).toBe(2);
    expect(a.stats.desyncFrame).toBeNull();
    expect(b.stats.desyncFrame).toBeNull();
    const common = [...a.hashes.local.keys()].filter((k) => b.hashes.local.has(k));
    expect(common.length).toBeGreaterThanOrEqual(8); // hashes older than 600 frames are pruned
    for (const k of common) expect(a.hashes.local.get(k)).toBe(b.hashes.local.get(k));
  });

  it('a click on a tick that waits for the opponent is not lost', () => {
    // B never sends anything, so A runs out of prediction and waits.
    const link = loopbackMesh(2, { latencyMs: 30 });
    const setup = (i: number) => ({ self: link.ids[i], host: link.ids[0], owners: link.ids, local: i });
    const a = new RollbackSession(createGame({ seed: 1 }), setup(0), link.meshes[0], config, { clock: () => link.now });
    for (let i = 0; i < 40; i++) { a.tick(emptyCommand()); link.advance(1000 / 60); }
    expect(a.stats.stalled).toBe(true);
    const frame = a.frame;
    a.tick({ ...emptyCommand(), fire: true }); // a quick click while waiting
    a.tick(emptyCommand());
    expect(a.frame).toBe(frame);
    // The opponent catches up; the click goes out with A's next frame.
    const sent: number[][] = [];
    link.meshes[1].onMessage((_, m) => { if (m.t === 'in') m.c.forEach(([, , ws]) => ws.forEach((w) => sent.push(w))); });
    const b = new RollbackSession(createGame({ seed: 1 }), setup(1), link.meshes[1], config, { clock: () => link.now });
    for (let i = 0; i < 20; i++) { a.tick(emptyCommand()); b.tick(emptyCommand()); link.advance(1000 / 60); }
    expect(sent.some((w) => (w[3] & 8) !== 0)).toBe(true);
  });

  it('an empowered shot over a laggy link hits on both machines with no long wait', () => {
    const { net: link, sessions: [a, b] } = mesh(2, { latencyMs: 90, jitterMs: 25, loss: 0.05, random: lcg(3) }, {}, () => { const g = createGame({ seed: 3 }); g.players[0].x = 6; g.players[0].z = 0; return g; });
    let start = -1, longestWait = 0, wait = 0, hits = 0;
    for (let i = 0; i < 900; i++) {
      const s = b.state, me = s.players[1], o = s.players[0];
      const c = { ...emptyCommand(), aimActive: true, aim: Math.atan2(o.z - me.z, o.x - me.x) };
      if (s.phase === 'playing') {
        if (start < 0) start = b.frame;
        const t = b.frame - start;
        c.roll = t >= 20 && t < 110; // roll and keep holding it,
        c.ads = t >= 40 && t < 110; // focus to kneel and charge,
        c.fire = t >= 100 && t < 103; // then fire the empowered shot
      }
      const before = a.frame;
      for (const e of a.tick(emptyCommand())) if (e.type === 'hit' && e.damage === 2) hits++;
      wait = a.frame === before ? wait + 1 : 0;
      longestWait = Math.max(longestWait, wait);
      b.tick(c);
      link.advance(1000 / 60);
    }
    expect(hits).toBe(1);
    expect(a.state.players[0].hp).toBe(b.state.players[0].hp);
    expect(a.state.players[0].hp).toBe(1);
    expect(longestWait).toBeLessThan(4);
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

describe('match stats', () => {
  it('counts shots, hits and the longest hit, and resets on rematch', () => {
    const g = createGame({ seed: 1 });
    g.arena.boxes = [];
    for (let i = 0; i < config.countdownTime * 60 + 2; i++) step(g, [emptyCommand(), emptyCommand()]);
    const aim = Math.atan2(g.players[1].z - g.players[0].z, g.players[1].x - g.players[0].x);
    for (let i = 0; i < 10; i++) step(g, [{ ...emptyCommand(), aimActive: true, aim, ads: true, fire: i >= 5 }, emptyCommand()]);
    expect(g.stats.shots[0]).toBe(1);
    expect(g.stats.hits[0]).toBe(1);
    expect(g.stats.longest[0]).toBeGreaterThan(20);
    g.phase = 'matchEnd';
    step(g, [{ ...emptyCommand(), start: true }, emptyCommand()]);
    expect(g.stats.shots).toEqual([0, 0]);
  });
});

describe('four players', () => {
  /** Run all sessions with scripted inputs; returns the longest wait (ticks without a new frame) per peer. */
  function run(sessions: RollbackSession[], net: { advance(ms: number): void }, frames: number, skip: Set<number> = new Set()) {
    const waits = sessions.map(() => 0), longest = sessions.map(() => 0);
    for (let i = 0; i < frames; i++) {
      sessions.forEach((s, k) => {
        if (skip.has(k)) return;
        const before = s.frame;
        s.tick(scripted(k, s.frame, s.state));
        waits[k] = s.frame === before ? waits[k] + 1 : 0;
        longest[k] = Math.max(longest[k], waits[k]);
      });
      net.advance(1000 / 60);
    }
    return longest;
  }
  const drain = (sessions: RollbackSession[], net: { advance(ms: number): void }, skip: Set<number> = new Set()) => {
    for (let i = 0; i < 90; i++) { sessions.forEach((s, k) => { if (!skip.has(k)) s.tick(emptyCommand()); }); net.advance(1000 / 60); }
  };
  const agree = (sessions: RollbackSession[]) => {
    const [a, ...rest] = sessions;
    let common = 0;
    for (const [f, h] of a.hashes.local) if (rest.every((b) => b.hashes.local.get(f) === h)) common++;
    for (const s of sessions) expect(s.stats.desyncFrame).toBeNull();
    return common;
  };

  it('four peers over 40-90 ms links with loss stay in sync', () => {
    const { net, sessions } = mesh(4, { latencyMs: 45, jitterMs: 15, loss: 0.05, random: lcg(9) });
    net.setLink(0, 3, { latencyMs: 90, jitterMs: 20, loss: 0.05 });
    run(sessions, net, 2400);
    drain(sessions, net);
    expect(agree(sessions)).toBeGreaterThan(5);
    expect(sessions[0].state.players.length).toBe(4);
    for (const s of sessions) expect(s.frame).toBeGreaterThan(2000);
  });

  it('a laggy player takes the extra input delay; the others stay low', () => {
    const { net, sessions } = mesh(4, { latencyMs: 25, jitterMs: 5, random: lcg(4) });
    for (const k of [0, 1, 2]) net.setLink(k, 3, { latencyMs: 130, jitterMs: 20 });
    run(sessions, net, 1200);
    expect(sessions[3].stats.inputDelay).toBeGreaterThanOrEqual(6);
    for (const k of [0, 1, 2]) expect(sessions[k].stats.inputDelay).toBeLessThanOrEqual(4);
    drain(sessions, net);
    expect(agree(sessions)).toBeGreaterThan(3);
  });

  it('a player who disconnects is replaced by a bot; the rest keep playing in sync', () => {
    const { net, sessions } = mesh(4, { latencyMs: 40, jitterMs: 10, random: lcg(2) }, { dropLaggers: true });
    run(sessions, net, 600);
    net.kill(2, 5000); // the tab dies; nobody gets a "left" notice for 5 s
    const longest = run(sessions, net, 900, new Set([2]));
    const alive = [sessions[0], sessions[1], sessions[3]];
    for (const s of alive) expect(s.drops.map(([slot]) => slot)).toEqual([2]);
    // Waiting is capped by the silence limit (2.5 s), not forever.
    for (const k of [0, 1, 3]) expect(longest[k]).toBeLessThan(60 * 3);
    drain(alive, net);
    expect(agree(alive)).toBeGreaterThan(3);
    expect(sessions[0].ownedSlots()).toContain(2); // the host plays the bot
  });

  it('a player whose inputs keep everyone waiting is dropped, and learns it', () => {
    const { net, sessions } = mesh(4, { latencyMs: 30, jitterMs: 5, random: lcg(5) }, { dropLaggers: true, maxSelfDelay: 4 });
    run(sessions, net, 300);
    for (const k of [0, 1, 2]) net.setLink(k, 3, { latencyMs: 400, jitterMs: 150, loss: 0.3 });
    run(sessions, net, 900);
    expect(sessions[3].stats.droppedSelf).toBe(true);
    const alive = sessions.slice(0, 3);
    for (const s of alive) expect(s.drops.map(([slot]) => slot)).toEqual([3]);
    drain(alive, net, new Set());
    expect(agree(alive)).toBeGreaterThan(3);
  });

  it('players whose browsers take a few seconds to load the match are not dropped', () => {
    const { net, sessions } = mesh(4, { latencyMs: 60, jitterMs: 10, random: lcg(8) }, { dropLaggers: true });
    run(sessions, net, 120, new Set([2, 3])); // 2 s: slots 2 and 3 are still loading
    run(sessions, net, 120, new Set([3])); // 4 s: slot 3 is still loading
    run(sessions, net, 600);
    for (const s of sessions) expect(s.drops).toEqual([]);
    drain(sessions, net);
    expect(agree(sessions)).toBeGreaterThan(3);
  });

  it('only the player who froze is dropped, not the ones waiting on them', () => {
    const { net, sessions } = mesh(4, { latencyMs: 50, jitterMs: 10, random: lcg(9) }, { dropLaggers: true });
    run(sessions, net, 600);
    run(sessions, net, 20, new Set([1])); // slot 1 hitches for a third of a second
    run(sessions, net, 600, new Set([3])); // slot 3's browser hangs
    const alive = sessions.slice(0, 3);
    for (const s of alive) expect(s.drops.map(([slot]) => slot)).toEqual([3]);
    drain(alive, net, new Set());
    expect(agree(alive)).toBeGreaterThan(3);
  });
});
