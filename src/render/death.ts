import * as THREE from 'three';

/**
 * Death effect, render only: a short pop of light, the robot breaking into a
 * few chunks, a scorch mark, and thin smoke rising from where they stood.
 * Kept understated: no big fireball, the smoke is light and fades in a few seconds.
 */

interface Chunk { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number; max: number; resting: boolean }
interface Puff { sprite: THREE.Sprite; vel: THREE.Vector3; delay: number; life: number; max: number; grow: number; peak: number }
interface Flash { mesh: THREE.Mesh; life: number; max: number }
interface Scorch { mesh: THREE.Mesh; life: number; max: number }

export class DeathFx {
  private chunks: Chunk[] = [];
  private puffs: Puff[] = [];
  private flashes: Flash[] = [];
  private scorches: Scorch[] = [];
  private smokeTex = smokeTexture();
  private chunkGeo = [new THREE.BoxGeometry(0.16, 0.12, 0.14), new THREE.BoxGeometry(0.1, 0.1, 0.22), new THREE.SphereGeometry(0.09, 8, 6), new THREE.BoxGeometry(0.22, 0.07, 0.12)];

  // One light, always in the scene and dark until a death. Adding or removing a light makes
  // three.js rebuild the shader of every lit material, which froze the game for a moment.
  private light = new THREE.PointLight(0xffa860, 0, 9, 2);

  constructor(private scene: THREE.Scene) {
    scene.add(this.light);
  }

  spawn(x: number, z: number, color: number, dirX: number, dirZ: number) {
    // Flash: a quick hot sphere and a light, gone in a quarter second.
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    flash.position.set(x, 1.0, z);
    this.light.position.set(x, 1.2, z);
    this.light.intensity = 60;
    this.scene.add(flash);
    this.flashes.push({ mesh: flash, life: 0.25, max: 0.25 });

    // Chunks: charred shell pieces plus a couple in the player color, thrown mostly along the shot.
    const charred = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.9, metalness: 0.1 });
    const shell = new THREE.MeshStandardMaterial({ color: 0x8d8f94, roughness: 0.7, metalness: 0.2 });
    const accent = new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: color, emissiveIntensity: 0.4 });
    for (let i = 0; i < 12; i++) {
      const mat = i < 2 ? accent : i % 2 ? charred : shell;
      const mesh = new THREE.Mesh(this.chunkGeo[i % this.chunkGeo.length], mat);
      mesh.castShadow = true;
      mesh.position.set(x + (Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 1.1, z + (Math.random() - 0.5) * 0.4);
      const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 2.5;
      const vel = new THREE.Vector3(Math.cos(a) * s + dirX * 2.5, 2 + Math.random() * 3, Math.sin(a) * s + dirZ * 2.5);
      const spin = new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5);
      this.scene.add(mesh);
      const max = 2.6 + Math.random();
      this.chunks.push({ mesh, vel, spin, life: max, max, resting: false });
    }

    // Scorch mark on the floor.
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(0.9, 28), new THREE.MeshBasicMaterial({ map: this.smokeTex, color: 0x000000, transparent: true, opacity: 0.75, depthWrite: false }));
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.set(x, 0.025, z);
    this.scene.add(scorch);
    this.scorches.push({ mesh: scorch, life: 6, max: 6 });

    // Smoke: thin grey wisps rising from the spot, staggered, light opacity.
    for (let i = 0; i < 9; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, color: i < 3 ? 0x55565a : 0x8a8c92, transparent: true, opacity: 0, depthWrite: false }));
      sprite.position.set(x + (Math.random() - 0.5) * 0.5, 0.3 + Math.random() * 0.4, z + (Math.random() - 0.5) * 0.5);
      sprite.scale.setScalar(0.5);
      this.scene.add(sprite);
      const max = 2.2 + Math.random() * 1.2;
      this.puffs.push({
        sprite, vel: new THREE.Vector3((Math.random() - 0.5) * 0.25, 0.55 + Math.random() * 0.4, (Math.random() - 0.5) * 0.25),
        delay: i * 0.12, life: max, max, grow: 0.5 + Math.random() * 0.4, peak: i < 3 ? 0.55 : 0.4,
      });
    }
  }

  /** New round: clear what is left of the last one. */
  clear() {
    for (const c of this.chunks) this.scene.remove(c.mesh);
    for (const p of this.puffs) { this.scene.remove(p.sprite); p.sprite.material.dispose(); }
    for (const f of this.flashes) this.scene.remove(f.mesh);
    this.light.intensity = 0;
    for (const s of this.scorches) this.scene.remove(s.mesh);
    this.chunks = []; this.puffs = []; this.flashes = []; this.scorches = [];
  }

  update(dt: number) {
    this.flashes = this.flashes.filter((f) => {
      f.life -= dt;
      const t = Math.max(0, f.life / f.max);
      f.mesh.scale.setScalar(1 + (1 - t) * 1.6);
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * t * t;
      this.light.intensity = 60 * t;
      if (f.life <= 0) { this.scene.remove(f.mesh); return false; }
      return true;
    });
    this.chunks = this.chunks.filter((c) => {
      c.life -= dt;
      if (!c.resting) {
        c.vel.y -= 14 * dt;
        c.mesh.position.addScaledVector(c.vel, dt);
        c.mesh.rotation.x += c.spin.x * dt; c.mesh.rotation.y += c.spin.y * dt; c.mesh.rotation.z += c.spin.z * dt;
        if (c.mesh.position.y < 0.05) {
          // Bounce once or twice with friction, then settle.
          c.mesh.position.y = 0.05;
          c.vel.y = -c.vel.y * 0.35; c.vel.x *= 0.5; c.vel.z *= 0.5; c.spin.multiplyScalar(0.5);
          if (Math.abs(c.vel.y) < 0.6) c.resting = true;
        }
      }
      // Sink into the floor at the end instead of popping out.
      if (c.life < 0.5) c.mesh.position.y = 0.05 - (0.5 - c.life) * 0.3;
      if (c.life <= 0) { this.scene.remove(c.mesh); return false; }
      return true;
    });
    this.puffs = this.puffs.filter((p) => {
      if (p.delay > 0) { p.delay -= dt; return true; }
      p.life -= dt;
      const age = 1 - p.life / p.max; // 0..1
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - 0.4 * dt);
      p.sprite.scale.setScalar(0.5 + age * p.grow * 2.2);
      // Fade in quickly, out slowly.
      p.sprite.material.opacity = p.peak * Math.min(1, age * 6) * (1 - age);
      p.sprite.material.rotation += dt * 0.3;
      if (p.life <= 0) { this.scene.remove(p.sprite); p.sprite.material.dispose(); return false; }
      return true;
    });
    this.scorches = this.scorches.filter((s) => {
      s.life -= dt;
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * Math.min(1, s.life / 1.5);
      if (s.life <= 0) { this.scene.remove(s.mesh); return false; }
      return true;
    });
  }
}

/** Soft round puff, shared by the smoke and the scorch mark. */
function smokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
