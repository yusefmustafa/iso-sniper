import * as THREE from 'three';
import { config } from '../config';
import { rayToCircle, rayToWorld } from '../sim/arena';
import { chargeProgress, hitRadius, isCharged, secToTicks } from '../sim/sim';
import type { GameState, PlayerState, SimEvent } from '../sim/types';
import { Character, makeGlintTexture, SHOULDER_HEIGHT } from './character';
import { DeathFx } from './death';

/**
 * The renderer only reads game state and sim events. It never changes the
 * simulation, so it can be swapped or run at any frame rate.
 */

export const PLAYER_COLORS = [0xff8a3d, 0x3dd6ff];
export const AIM_HEIGHT = SHOULDER_HEIGHT; // rifle height: lasers, tracers and the mouse aim plane
const CAM_OFFSET = new THREE.Vector3(20, 24, 20);

interface PlayerView {
  char: Character; // body, rifle and animation
  laserOuter: THREE.Mesh;
  laserCore: THREE.Mesh;
  ring: THREE.Mesh;
  alive: boolean; // last frame's state, to catch the moment of death
  hitDir: { x: number; z: number }; // direction of the last shot that hit, to throw the debris
}

const MUZZLE_REACH = 1.68; // muzzle distance in front of the character, for the laser
const MUZZLE_SIDE = 0.13; // muzzle offset to the character's right

interface Tracer { mesh: THREE.Mesh; life: number; max: number }
interface Spark { mesh: THREE.Mesh; vel: THREE.Vector3; life: number }

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private views: PlayerView[] = [];
  private tracers: Tracer[] = [];
  private sparks: Spark[] = [];
  private muzzleLight = new THREE.PointLight(0xffd8a0, 0, 8, 2);
  private camTarget = new THREE.Vector3();
  private camVel = new THREE.Vector3();
  private zoom = 14;
  private zoomVel = 0;
  private trauma = 0;
  private ringGeoms: THREE.RingGeometry[] = [];
  private raycaster = new THREE.Raycaster();
  private aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -AIM_HEIGHT);
  private time = 0;
  private glintTexture: THREE.Texture | null = null;
  private deaths = new DeathFx(this.scene);
  /** Interpolated player positions from the last render, for overlays. */
  positions: { x: number; z: number }[] = [];
  private arenaBuilt = false;
  private warmed = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color(0x14161c);
    this.scene.fog = new THREE.Fog(0x14161c, 40, 80);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x2a2420, 1.1));
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
    sun.position.set(-12, 30, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -26; sc.right = 26; sc.top = 20; sc.bottom = -20; sc.near = 1; sc.far = 80;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.scene.add(this.muzzleLight);

    for (let i = 0; i <= 32; i++) this.ringGeoms.push(new THREE.RingGeometry(0.55, 0.68, 40, 1, 0, Math.max(0.001, (i / 32) * Math.PI * 2)));

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.applyZoom();
  }

  private applyZoom() {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const halfH = this.zoom / 2;
    this.camera.left = -halfH * aspect; this.camera.right = halfH * aspect;
    this.camera.top = halfH; this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  /** Screen position to a point on the aim plane, used for mouse aiming. */
  screenToWorld = (clientX: number, clientY: number) => {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.aimPlane, hit) ? { x: hit.x, z: hit.z } : null;
  };

  /** World position to screen pixels, used to place HUD elements over heads. */
  worldToScreen(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight };
  }

  private buildArena(state: GameState) {
    const { arena } = state;
    // Floor with a subtle 1 m grid
    const tex = this.gridTexture();
    tex.repeat.set(arena.width / 2, arena.depth / 2);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(arena.width, arena.depth),
      new THREE.MeshStandardMaterial({ color: 0x3a3f4a, map: tex, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Ground beyond the arena
    const outside = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x1b1e25, roughness: 1 }));
    outside.rotation.x = -Math.PI / 2;
    outside.position.y = -0.02;
    outside.receiveShadow = true;
    this.scene.add(outside);

    const coverMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.8 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xc9ced8, transparent: true, opacity: 0.35 });
    const addBlock = (x: number, z: number, w: number, d: number, h: number, mat: THREE.Material) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, h / 2, z);
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
      e.position.copy(m.position);
      this.scene.add(e);
    };
    for (const b of arena.boxes) addBlock(b.x, b.z, b.w, b.d, b.h, coverMat);

    // Border walls
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x555b66, roughness: 0.9 });
    const t = 0.5, wh = 0.8, hw = arena.width / 2, hd = arena.depth / 2;
    addBlock(0, -hd - t / 2, arena.width + 2 * t, t, wh, wallMat);
    addBlock(0, hd + t / 2, arena.width + 2 * t, t, wh, wallMat);
    addBlock(-hw - t / 2, 0, t, arena.depth, wh, wallMat);
    addBlock(hw + t / 2, 0, t, arena.depth, wh, wallMat);

    // Spawn pads in player colors
    arena.spawns.forEach((s, i) => {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(1.2, 32), new THREE.MeshBasicMaterial({ color: PLAYER_COLORS[i], transparent: true, opacity: 0.12 }));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(s.x, 0.01, s.z);
      this.scene.add(pad);
    });
  }

  private gridTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#c9ccd4'; g.lineWidth = 2;
    g.strokeRect(0, 0, 128, 128);
    g.strokeStyle = '#e4e6ea'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(64, 0); g.lineTo(64, 128); g.moveTo(0, 64); g.lineTo(128, 64); g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  private buildPlayer(i: number): PlayerView {
    const color = new THREE.Color(PLAYER_COLORS[i]);
    this.glintTexture ??= makeGlintTexture();
    const char = new Character(PLAYER_COLORS[i], this.glintTexture);
    const root = char.root;

    // Lasers live in world space (not under root) so they can be any length.
    const laserOuter = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    const laserCore = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }));
    laserOuter.visible = laserCore.visible = false;
    this.scene.add(laserOuter, laserCore);

    // Ground ring: bolt cycle (grey) and charge (player color)
    const ring = new THREE.Mesh(this.ringGeoms[0], new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    root.add(ring);

    // Soft player-colored ground glow for readability
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    root.add(glow);

    this.scene.add(root);
    return { char, laserOuter, laserCore, ring, alive: true, hitDir: { x: 1, z: 0 } };
  }

  /** React to sim events with one-off effects. */
  onEvents(events: SimEvent[], state: GameState) {
    for (const e of events) {
      if (e.type === 'shot') {
        this.spawnTracer(e.fromX, e.fromZ, e.toX, e.toZ, e.charged, e.player);
        this.views[e.player].char.recoil = e.charged ? 1.6 : 1;
        this.muzzleLight.position.set(e.fromX, AIM_HEIGHT + 0.2, e.fromZ);
        this.muzzleLight.intensity = e.charged ? 40 : 25;
        this.addTrauma(e.charged ? 0.35 : 0.2);
        // A shot into an invulnerable player stops in a burst of white: no damage.
        this.spawnSparks(e.toX, e.toZ, e.blocked ? 0xffffff : e.hit !== null ? PLAYER_COLORS[e.hit] : 0xffe2b0, e.hit !== null ? 14 : 8);
      } else if (e.type === 'hit') {
        this.views[e.player].char.flash = 0.12;
        this.views[e.player].hitDir = { x: e.dirX, z: e.dirZ };
        this.addTrauma(e.damage > 1 ? 0.8 : 0.5);
      } else if (e.type === 'charged') {
        this.views[e.player].char.glintBurst = 1;
      } else if (e.type === 'roundStart') {
        this.camVel.set(0, 0, 0);
        this.deaths.clear();
      }
    }
    void state;
  }

  /**
   * Compile every shader the effects use before the match, so the first glint,
   * tracer or death doesn't stall a frame while the browser compiles it.
   */
  private prewarm() {
    this.spawnTracer(0, 0, 1, 0, true, 0);
    this.spawnSparks(0, 0, 0xffffff, 1);
    this.deaths.spawn(0, 0, PLAYER_COLORS[0], 1, 0);
    for (const v of this.views) v.char.glint.visible = true;
    this.renderer.compile(this.scene, this.camera);
    for (const v of this.views) v.char.glint.visible = false;
    for (const t of this.tracers) { this.scene.remove(t.mesh); t.mesh.geometry.dispose(); (t.mesh.material as THREE.Material).dispose(); }
    for (const sp of this.sparks) { this.scene.remove(sp.mesh); sp.mesh.geometry.dispose(); (sp.mesh.material as THREE.Material).dispose(); }
    this.tracers = []; this.sparks = [];
    this.deaths.clear();
  }

  private addTrauma(t: number) { this.trauma = Math.min(1, this.trauma + t); }

  private spawnTracer(fx: number, fz: number, tx: number, tz: number, charged: boolean, player: number) {
    const len = Math.hypot(tx - fx, tz - fz);
    const mat = new THREE.MeshBasicMaterial({ color: charged ? 0xffffff : 0xffe7b8, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const w = charged ? 0.14 : 0.07;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, w, w), mat);
    mesh.position.set((fx + tx) / 2, AIM_HEIGHT, (fz + tz) / 2);
    mesh.rotation.y = -Math.atan2(tz - fz, tx - fx);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life: 0.18, max: 0.18 });
    void player;
  }

  private spawnSparks(x: number, z: number, color: number, n: number) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), mat.clone());
      mesh.position.set(x, AIM_HEIGHT, z);
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
      this.scene.add(mesh);
      this.sparks.push({ mesh, vel: new THREE.Vector3(Math.cos(a) * s, 1 + Math.random() * 4, Math.sin(a) * s), life: 0.25 + Math.random() * 0.25 });
    }
  }

  /**
   * Draw a frame. `prev` and `alpha` interpolate positions between sim ticks,
   * so motion is smooth at any refresh rate.
   */
  render(state: GameState, prev: { x: number; z: number }[], alpha: number, dt: number, frozen: boolean) {
    if (!this.arenaBuilt) { this.buildArena(state); this.arenaBuilt = true; }
    while (this.views.length < state.players.length) this.views.push(this.buildPlayer(this.views.length));
    if (!this.warmed && this.views.length >= 2) { this.prewarm(); this.warmed = true; }
    this.time += dt;

    const positions = this.positions = state.players.map((p, i) => ({
      x: prev[i] ? prev[i].x + (p.x - prev[i].x) * alpha : p.x,
      z: prev[i] ? prev[i].z + (p.z - prev[i].z) * alpha : p.z,
    }));

    state.players.forEach((p, i) => this.updatePlayerView(state, p, this.views[i], positions[i], dt, frozen));
    this.updateCamera(state, positions, dt);
    this.updateEffects(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private updatePlayerView(state: GameState, p: PlayerState, v: PlayerView, pos: { x: number; z: number }, dt: number, frozen: boolean) {
    v.char.root.position.set(pos.x, 0, pos.z);
    // Death: the body is replaced by the explosion until the next round. Driven by hp (not the
    // event), so a rollback correction can't leave a stale body or a double explosion behind.
    const alive = p.hp > 0;
    if (v.alive && !alive) this.deaths.spawn(pos.x, pos.z, PLAYER_COLORS[p.id], v.hitDir.x, v.hitDir.z);
    v.alive = alive;
    v.char.root.visible = alive;
    v.char.update(p, dt, frozen, this.time);
    const fwdX = Math.cos(p.aim), fwdZ = Math.sin(p.aim);

    // Laser: from the muzzle to the first wall or player along the aim.
    const showLaser = alive && p.ads && state.phase !== 'countdown';
    v.laserOuter.visible = v.laserCore.visible = showLaser;
    if (showLaser) {
      // The rifle sits on the right shoulder, so the laser starts a little right of center.
      const ox = pos.x + fwdX * MUZZLE_REACH - fwdZ * MUZZLE_SIDE, oz = pos.z + fwdZ * MUZZLE_REACH + fwdX * MUZZLE_SIDE;
      let dist = rayToWorld(state.arena, ox, oz, fwdX, fwdZ, config.shotRange);
      for (const o of state.players) {
        if (o.id === p.id) continue;
        dist = Math.min(dist, rayToCircle(ox, oz, fwdX, fwdZ, o.x, o.z, hitRadius(o)));
      }
      const charged = isCharged(p);
      const pulse = charged ? 1 + Math.sin(this.time * 30) * 0.25 : 1;
      const progress = chargeProgress(p);
      const outerW = (charged ? 0.16 : 0.07 + progress * 0.04) * pulse;
      const coreW = charged ? 0.05 : 0.025;
      for (const [m, w] of [[v.laserOuter, outerW], [v.laserCore, coreW]] as const) {
        m.scale.set(dist, w, w);
        m.position.set(ox + fwdX * dist / 2, AIM_HEIGHT, oz + fwdZ * dist / 2);
        m.rotation.y = -p.aim;
      }
      (v.laserOuter.material as THREE.MeshBasicMaterial).opacity = charged ? 0.85 : 0.4 + progress * 0.3;
    }

    // Ground ring: bolt progress while cycling, otherwise charge progress in ADS.
    const ringMat = v.ring.material as THREE.MeshBasicMaterial;
    let frac = 0;
    if (p.boltTicks > 0) {
      frac = 1 - p.boltTicks / secToTicks(config.boltTime);
      ringMat.color.setHex(0x8b909b);
    } else if (p.ads && p.stance === 'kneel') {
      frac = chargeProgress(p);
      ringMat.color.setHex(isCharged(p) ? 0xffffff : PLAYER_COLORS[p.id]);
    }
    v.ring.geometry = this.ringGeoms[Math.round(frac * 32)];
    v.ring.visible = alive && frac > 0;
  }

  private updateCamera(state: GameState, pos: { x: number; z: number }[], dt: number) {
    // Frame both players, leaning a little toward where each one aims.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    state.players.forEach((p, i) => {
      const lead = p.ads ? 2.5 : 1.2;
      for (const q of [pos[i], { x: pos[i].x + Math.cos(p.aim) * lead, z: pos[i].z + Math.sin(p.aim) * lead }]) {
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
        minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
      }
    });
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

    // Critically damped spring toward the target: smooth, never overshoots.
    const omega = 6;
    const spring = (x: number, v: number, target: number) => {
      const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
      const detInv = 1 / (f + hhoo);
      const nx = (f * x + dt * v + hhoo * target) * detInv;
      const nv = (v + hoo * (target - x)) * detInv;
      return [nx, nv];
    };
    [this.camTarget.x, this.camVel.x] = spring(this.camTarget.x, this.camVel.x, cx);
    [this.camTarget.z, this.camVel.z] = spring(this.camTarget.z, this.camVel.z, cz);

    // Zoom: fit the players' spread in screen space, within limits.
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const right = new THREE.Vector2(Math.SQRT1_2, -Math.SQRT1_2); // screen right on the ground
    const up = new THREE.Vector2(-Math.SQRT1_2, -Math.SQRT1_2); // screen up on the ground
    let sw = 0, sh = 0;
    for (const a of pos) for (const b of pos) {
      const dx = a.x - b.x, dz = a.z - b.z;
      sw = Math.max(sw, Math.abs(dx * right.x + dz * right.y));
      sh = Math.max(sh, Math.abs(dx * up.x + dz * up.y) * 0.78); // ground foreshortening at this camera pitch
    }
    const want = Math.max(13, Math.min(30, Math.max(sh + 7, (sw + 9) / aspect)));
    [this.zoom, this.zoomVel] = spring(this.zoom, this.zoomVel, want);
    this.applyZoom();

    // Shake from trauma (squared for a punchy falloff)
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    const s = this.trauma * this.trauma * 0.45;
    const t = this.time * 60;
    const shake = new THREE.Vector3(Math.sin(t * 1.1) * s, Math.sin(t * 1.7 + 1) * s * 0.5, Math.sin(t * 1.3 + 2) * s);
    this.camera.position.copy(this.camTarget).add(CAM_OFFSET).add(shake);
    this.camera.lookAt(this.camTarget.x + shake.x, 0, this.camTarget.z + shake.z);
  }

  private updateEffects(dt: number) {
    this.deaths.update(dt);
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 300);
    this.tracers = this.tracers.filter((t) => {
      t.life -= dt;
      const m = t.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = Math.max(0, t.life / t.max);
      t.mesh.scale.y = t.mesh.scale.z = 0.4 + 0.6 * (t.life / t.max);
      if (t.life <= 0) { this.scene.remove(t.mesh); t.mesh.geometry.dispose(); m.dispose(); return false; }
      return true;
    });
    this.sparks = this.sparks.filter((s) => {
      s.life -= dt;
      s.vel.y -= 14 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      const m = s.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = Math.max(0, s.life * 3);
      if (s.life <= 0 || s.mesh.position.y < 0) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); m.dispose(); return false; }
      return true;
    });
  }
}
