import { config as defaultConfig, type Config } from '../config';
import { rayToWorld } from '../sim/arena';
import { chargeTicksFor, gunUp, MUZZLE_OFFSET } from '../sim/sim';
import { emptyCommand, type Command, type GameState, type PlayerState } from '../sim/types';

/**
 * A scripted opponent. It reads the game state each tick and returns a Command,
 * exactly like a keyboard or controller would, so it plays through the real
 * input path (and online, through the real netcode). It never touches the sim.
 *
 * It is not deterministic and doesn't need to be: its commands are inputs,
 * which the netcode sends to the other player like any human's.
 */

export type BotLevel = 'easy' | 'normal' | 'hard';

interface Skill {
  reaction: number; // seconds before it starts aiming at a newly visible target
  aimTime: [number, number]; // seconds of focus before a normal shot
  aimError: number; // radians of aim error when focus starts; it settles toward 0
  settle: number; // seconds for the aim error to halve
  dodge: number; // chance per second to roll when the opponent's laser is on it
  empower: number; // chance to go for an empowered shot when one is possible
  turnRate: number; // radians per second the aim can swing
}

const SKILLS: Record<BotLevel, Skill> = {
  easy: { reaction: 0.45, aimTime: [0.7, 1.3], aimError: 0.12, settle: 0.45, dodge: 0.6, empower: 0.15, turnRate: 5 },
  normal: { reaction: 0.28, aimTime: [0.45, 0.9], aimError: 0.08, settle: 0.3, dodge: 1.6, empower: 0.3, turnRate: 9 },
  hard: { reaction: 0.16, aimTime: [0.3, 0.6], aimError: 0.05, settle: 0.18, dodge: 3, empower: 0.4, turnRate: 16 },
};

type Plan = 'reposition' | 'aim' | 'empower';

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class BotBrain {
  readonly skill: Skill;
  private plan: Plan = 'reposition';
  private planT = 0; // seconds in the current plan
  private aimFor = 0; // seconds of focus this shot wants
  private err = 0; // current aim error, radians
  private aim = 0; // where the bot's "hand" is pointing
  private seenFor = 0; // seconds the opponent has been in line of sight
  private strafe = 1; // +1 / -1: which way it circles
  private strafeT = 0;
  private fireTicks = 0; // >0 while the fire button is held
  private rollTicks = 0; // >0 while the roll button is held
  private rollDir = { x: 0, z: 0 };
  private wantDist = rand(9, 15);
  private lastPos = { x: 0, z: 0 };
  private stuckT = 0;
  private detour = 0; // seconds left walking sideways around cover
  private target = -1; // player slot it is fighting
  private retarget = 0; // seconds until it reconsiders the target

  constructor(level: BotLevel = 'normal') {
    this.skill = SKILLS[level];
  }

  think(state: GameState, me: number, cfg: Config = defaultConfig): Command {
    const dt = 1 / cfg.tickRate;
    const c = emptyCommand();
    const p = state.players[me];
    const o = this.pickTarget(state, p, dt);
    c.aimActive = true;
    if (!o || p.hp <= 0) { c.aim = this.aim; this.reset(); return c; }
    const dx = o.x - p.x, dz = o.z - p.z;
    const dist = Math.hypot(dx, dz);
    const toward = Math.atan2(dz, dx);
    const visible = this.lineOfSight(state, p, o);
    this.seenFor = visible ? this.seenFor + dt : 0;

    if (state.phase === 'matchEnd') {
      // The human calls the rematch (Enter or Start), so they get to read the results first.
      c.aim = this.aim;
      return c;
    }
    if (state.phase !== 'playing') {
      this.reset();
      this.aim = toward;
      c.aim = toward;
      return c;
    }

    this.planT += dt;
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafe = Math.random() < 0.5 ? -1 : 1; this.strafeT = rand(0.6, 1.8); this.wantDist = rand(8, 15); }

    // Where to point: the opponent, a little ahead of where they're moving, plus a settling error.
    const lead = dist / 60; // bullets are instant; this is the bot's own reaction lag compensation
    const target = Math.atan2(o.z + o.vz * lead - p.z, o.x + o.vx * lead - p.x);
    this.err *= Math.pow(0.5, dt / this.skill.settle);
    const want = target + this.err;
    const delta = wrap(want - this.aim);
    const maxTurn = this.skill.turnRate * dt;
    this.aim = wrap(this.aim + Math.max(-maxTurn, Math.min(maxTurn, delta)));
    c.aim = this.aim;

    // Movement: keep a comfortable range and circle; walk around cover when blocked.
    let mx = 0, mz = 0;
    const ux = dx / (dist || 1), uz = dz / (dist || 1);
    const range = dist - this.wantDist;
    const radial = Math.max(-1, Math.min(1, range / 4));
    mx = ux * radial - uz * this.strafe * 0.8;
    mz = uz * radial + ux * this.strafe * 0.8;
    if (!visible) {
      // Close in, sliding sideways so we come around the box.
      mx = ux - uz * this.strafe * 0.9;
      mz = uz + ux * this.strafe * 0.9;
    }
    if (this.detour > 0) { this.detour -= dt; mx = -uz * this.strafe; mz = ux * this.strafe; }
    // Stay away from the arena edges.
    const hx = state.arena.width / 2 - 2.5, hz = state.arena.depth / 2 - 2.5;
    if (p.x > hx) mx -= 1; if (p.x < -hx) mx += 1;
    if (p.z > hz) mz -= 1; if (p.z < -hz) mz += 1;
    // Unstick: if we barely moved while trying to, go sideways for a bit.
    const moved = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z);
    this.lastPos = { x: p.x, z: p.z };
    if (Math.hypot(mx, mz) > 0.3 && moved < 0.01 && p.stance !== 'kneel' && p.stunTicks === 0) this.stuckT += dt; else this.stuckT = 0;
    if (this.stuckT > 0.25) { this.stuckT = 0; this.strafe = -this.strafe; this.detour = rand(0.4, 0.8); }
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    c.moveX = mx; c.moveZ = mz;

    // A hit cancels focus until the button is let go: let go, and start the aim over.
    if (p.adsLock || p.stunTicks > 0) { this.toPlan('reposition'); }

    const loaded = p.boltTicks === 0;
    const canShoot = visible && loaded && this.seenFor >= this.skill.reaction && o.hp > 0 && !p.adsLock;

    // Dodge: someone is focusing at us. Roll across their laser now and then.
    const threatened = state.players.some((q) => {
      if (q.id === me || q.hp <= 0 || !q.ads || q.boltTicks > 0) return false;
      const err = Math.abs(wrap(q.aim - Math.atan2(p.z - q.z, p.x - q.x)));
      return err < 0.12 && (q === o ? visible : this.lineOfSight(state, q, p));
    });
    if (this.plan !== 'empower' && threatened && p.rollCooldownTicks === 0 && p.stance !== 'roll' && this.rollTicks === 0
      && Math.random() < this.skill.dodge * dt) {
      this.startRoll(-uz * this.strafe, ux * this.strafe, 2);
      this.toPlan('reposition');
    }

    switch (this.plan) {
      case 'reposition':
        if (canShoot && p.stance !== 'roll') {
          const empowerOk = p.rollCooldownTicks === 0 && dist > 7 && Math.random() < this.skill.empower;
          if (empowerOk) {
            // Roll sideways and keep holding roll + focus: land in a kneel and charge.
            this.startRoll(-uz * this.strafe, ux * this.strafe, 999);
            this.toPlan('empower');
          } else {
            this.toPlan('aim');
          }
        } else {
          c.sprint = !visible && dist > 10 && p.stance !== 'roll';
        }
        break;
      case 'aim': {
        c.ads = true;
        c.moveX *= 0.6; c.moveZ *= 0.6;
        if (!visible || !loaded) { this.toPlan('reposition'); break; }
        if (this.planT >= this.aimFor && Math.abs(wrap(want - this.aim)) < 0.02 && gunUp(p) && p.ads) {
          this.fireTicks = 2;
          this.toPlan('reposition');
        }
        if (this.planT > 3) this.toPlan('reposition');
        break;
      }
      case 'empower': {
        c.ads = true;
        c.roll = true;
        this.rollTicks = Math.max(this.rollTicks, 1);
        const charged = p.stance === 'kneel' && p.adsTicks >= chargeTicksFor(p, cfg);
        if (p.stance === 'kneel') { c.moveX = 0; c.moveZ = 0; }
        if (charged && Math.abs(wrap(want - this.aim)) < 0.02 && visible) {
          this.fireTicks = 2;
          this.rollTicks = 0;
          this.toPlan('reposition');
          c.roll = true; // keep the kneel for the shot's tick
        } else if (this.planT > 0.4 && p.stance !== 'kneel' && p.stance !== 'roll') {
          this.rollTicks = 0; // missed the kneel window
          this.toPlan('reposition');
        } else if (this.planT > 2.5 || (p.stance === 'kneel' && !visible && this.planT > 1.2)) {
          this.rollTicks = 0;
          this.toPlan('reposition');
        }
        break;
      }
    }

    if (this.rollTicks > 0) {
      this.rollTicks--;
      c.roll = true;
      if (p.stance === 'roll' || this.plan === 'empower') { c.moveX = this.rollDir.x; c.moveZ = this.rollDir.z; }
    }
    if (this.fireTicks > 0) {
      this.fireTicks--;
      c.fire = true;
      c.ads = true;
      if (p.stance === 'kneel') c.roll = true;
    }
    return c;
  }

  /**
   * Who to fight. In a duel, the other player. In a free-for-all it sticks with
   * its target while it can see them, and otherwise switches to the nearest
   * player it can see (or the nearest one at all).
   */
  private pickTarget(state: GameState, p: PlayerState, dt: number): PlayerState | null {
    const others = state.players.filter((q) => q.id !== p.id && q.hp > 0);
    if (others.length <= 1) { this.target = others[0]?.id ?? -1; return others[0] ?? null; }
    this.retarget -= dt;
    const cur = state.players[this.target];
    const keep = cur && cur.id !== p.id && cur.hp > 0 && this.retarget > 0;
    if (keep) return cur;
    this.retarget = rand(0.4, 0.8);
    const d = (q: PlayerState) => Math.hypot(q.x - p.x, q.z - p.z);
    const seen = others.filter((q) => this.lineOfSight(state, p, q));
    const pool = seen.length ? seen : others;
    let best = pool.reduce((a, b) => (d(b) < d(a) ? b : a));
    // Don't flip between two similar targets: keep the current one unless the new one is clearly closer.
    if (cur && cur.hp > 0 && cur.id !== p.id && pool.includes(cur) && d(best) > d(cur) * 0.7) best = cur;
    if (best.id !== this.target) this.seenFor = 0;
    this.target = best.id;
    return best;
  }

  private startRoll(x: number, z: number, holdTicks: number) {
    const l = Math.hypot(x, z) || 1;
    this.rollDir = { x: x / l, z: z / l };
    this.rollTicks = holdTicks;
  }

  private toPlan(plan: Plan) {
    if (plan === 'aim' || plan === 'empower') {
      this.aimFor = rand(this.skill.aimTime[0], this.skill.aimTime[1]);
      this.err = (Math.random() < 0.5 ? -1 : 1) * this.skill.aimError * rand(0.5, 1.2);
    }
    this.plan = plan;
    this.planT = 0;
  }

  private reset() {
    this.plan = 'reposition'; this.planT = 0; this.fireTicks = 0; this.rollTicks = 0; this.seenFor = 0; this.detour = 0;
  }

  /** Can a shot from p's muzzle reach o without hitting a box? */
  private lineOfSight(state: GameState, p: PlayerState, o: PlayerState): boolean {
    const dx = o.x - p.x, dz = o.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return true;
    const ux = dx / d, uz = dz / d;
    const ox = p.x + ux * MUZZLE_OFFSET * 0.5, oz = p.z + uz * MUZZLE_OFFSET * 0.5;
    // Check the center and both edges of the body so a half-covered target still counts.
    const r = 0.3;
    for (const s of [0, -1, 1]) {
      const tx = o.x - uz * r * s, tz = o.z + ux * r * s;
      const ex = tx - ox, ez = tz - oz;
      const el = Math.hypot(ex, ez);
      if (rayToWorld(state.arena, ox, oz, ex / el, ez / el, el + 1) >= el - 0.05) return true;
    }
    return false;
  }
}
