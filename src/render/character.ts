import * as THREE from 'three';
import { config } from '../config';
import { chargeProgress, isCharged, secToTicks } from '../sim/sim';
import type { PlayerState } from '../sim/types';

/**
 * A procedural robot rifleman (segmented limbs and joints, in the spirit of a
 * Mixamo test robot) plus its animation. Render only: it reads player state
 * and never feeds anything back into the sim, so rollback is unaffected.
 *
 * Local frame: +X is where the player aims, +Y up, +Z the character's right.
 *
 *   root (position, yaw) -> body (lean, crouch) -> pivot (roll flip, at the hips) -> model
 */

export const SHOULDER_HEIGHT = 1.38; // where the rifle sits; the aim plane uses this
const HIP_Y = 0.92;
const THIGH = 0.44;
const SHIN = 0.42;
const PIVOT_Y = 0.75;
const UPPER_ARM = 0.29;
const FOREARM = 0.29;
const TAU = Math.PI * 2;

const Y_AXIS = new THREE.Vector3(0, 1, 0);

interface Leg { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group }
interface Arm { shoulder: THREE.Vector3; upper: THREE.Mesh; fore: THREE.Mesh; elbow: THREE.Mesh; hand: THREE.Mesh; grip: THREE.Vector3; pole: THREE.Vector3 }

export class Character {
  readonly root = new THREE.Group();
  /** Hit flash: [shell, accent] materials. */
  private materials: THREE.MeshStandardMaterial[];
  private body = new THREE.Group();
  private pivot = new THREE.Group();
  private model = new THREE.Group();
  private gun = new THREE.Group();
  private legs: Leg[] = [];
  private arms: Arm[] = [];
  private glint: THREE.Sprite;

  flash = 0; // seconds of white hit flash left
  recoil = 0; // 0..1 (empowered shots kick to >1)
  glintBurst = 0; // 0..1, flares when the empowered shot becomes ready
  private rollSpin = 0;
  private wasRolling = false;
  private land = 0; // 0..1 landing crouch after a roll
  private tuck = 0; // 0..1 legs tucked (rolling)
  private bob = 0;
  private lean = new THREE.Vector2();
  private kneel = 0;
  private gunDown = 0;
  private walk = 0;
  private stepDir = new THREE.Vector2(1, 0);
  private rollAxis = new THREE.Vector2(1, 0); // roll direction in the local frame, kept after the roll for the settle

  constructor(private color: number, glintTexture: THREE.Texture) {
    const c = new THREE.Color(color);
    const shell = new THREE.MeshStandardMaterial({ color: 0xd4d8e0, roughness: 0.45, metalness: 0.25, emissive: c, emissiveIntensity: 0.12 });
    const accent = new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, metalness: 0.3, emissive: c, emissiveIntensity: 0.6 });
    const joint = new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.6, metalness: 0.4 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x1d2026, roughness: 0.45, metalness: 0.7 });
    const polymer = new THREE.MeshStandardMaterial({ color: 0x3b4049, roughness: 0.75, metalness: 0.1 });
    const lens = new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.1, metalness: 0.9, emissive: c, emissiveIntensity: 0.35 });
    this.materials = [shell, accent];

    this.root.add(this.body);
    this.body.add(this.pivot);
    this.pivot.position.y = PIVOT_Y;
    this.pivot.add(this.model);
    this.model.position.y = -PIVOT_Y;
    const m = this.model;

    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const ellipsoid = (rx: number, ry: number, rz: number) => new THREE.SphereGeometry(1, 20, 14).scale(rx, ry, rz);
    const alongX = (geo: THREE.BufferGeometry) => geo.rotateZ(-Math.PI / 2);

    // ---- torso
    add(m, ellipsoid(0.17, 0.11, 0.2), shell, 0, HIP_Y + 0.02, 0); // pelvis
    add(m, new THREE.CylinderGeometry(0.1, 0.12, 0.2, 14), joint, 0, HIP_Y + 0.16, 0); // waist
    add(m, ellipsoid(0.19, 0.25, 0.25), shell, 0, 1.3, 0); // chest
    add(m, new THREE.BoxGeometry(0.06, 0.16, 0.24), accent, 0.17, 1.33, 0); // chest plate
    add(m, ellipsoid(0.12, 0.08, 0.1), joint, -0.17, 1.3, 0); // back pack
    add(m, new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10), joint, 0, 1.55, 0); // neck
    add(m, ellipsoid(0.14, 0.16, 0.13), shell, 0.01, 1.68, 0); // head
    add(m, new THREE.BoxGeometry(0.05, 0.06, 0.2), accent, 0.13, 1.7, 0); // visor
    for (const side of [-1, 1]) add(m, new THREE.SphereGeometry(0.085, 14, 10), shell, 0, SHOULDER_HEIGHT + 0.06, side * 0.25); // shoulder caps

    // ---- legs: hip -> knee -> ankle, each a pivot
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(0, HIP_Y, side * 0.11);
      add(hip, new THREE.SphereGeometry(0.075, 12, 10), joint);
      add(hip, new THREE.CapsuleGeometry(0.075, THIGH - 0.15, 4, 10), shell, 0, -THIGH / 2, 0);
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      hip.add(knee);
      add(knee, new THREE.SphereGeometry(0.065, 12, 10), joint);
      add(knee, new THREE.CapsuleGeometry(0.065, SHIN - 0.13, 4, 10), shell, 0, -SHIN / 2, 0);
      const ankle = new THREE.Group();
      ankle.position.y = -SHIN;
      knee.add(ankle);
      add(ankle, new THREE.BoxGeometry(0.24, 0.08, 0.12), joint, 0.05, -0.02, 0); // boot
      add(ankle, new THREE.BoxGeometry(0.1, 0.03, 0.125), accent, 0.12, -0.05, 0); // toe cap
      m.add(hip);
      this.legs.push({ hip, knee, ankle });
    }

    // ---- rifle: pivot at the right shoulder pocket, barrel along +X
    const g = this.gun;
    g.position.set(0.02, SHOULDER_HEIGHT, 0.13);
    add(g, new THREE.BoxGeometry(0.3, 0.1, 0.05), polymer, -0.05, -0.03, 0); // stock
    add(g, new THREE.BoxGeometry(0.16, 0.04, 0.05), polymer, -0.04, 0.035, 0); // cheek rest
    add(g, new THREE.BoxGeometry(0.03, 0.14, 0.06), joint, -0.2, -0.03, 0); // butt pad
    add(g, new THREE.BoxGeometry(0.34, 0.075, 0.065), metal, 0.25, 0, 0); // receiver
    const grip = add(g, new THREE.BoxGeometry(0.05, 0.12, 0.045), polymer, 0.13, -0.08, 0);
    grip.rotation.z = 0.35;
    add(g, new THREE.BoxGeometry(0.07, 0.09, 0.05), metal, 0.27, -0.075, 0); // magazine
    add(g, alongX(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 12)), polymer, 0.56, 0, 0); // handguard
    add(g, alongX(new THREE.CylinderGeometry(0.014, 0.016, 0.62, 10)), metal, 0.98, 0, 0); // barrel
    add(g, new THREE.BoxGeometry(0.07, 0.035, 0.045), metal, 1.31, 0, 0); // muzzle brake
    add(g, new THREE.SphereGeometry(0.018, 8, 6), metal, 0.18, 0.02, 0.05); // bolt handle
    // Scope: tube, eyepiece and objective bell, on two rings
    add(g, alongX(new THREE.CylinderGeometry(0.026, 0.026, 0.3, 14)), metal, 0.24, 0.085, 0);
    add(g, alongX(new THREE.CylinderGeometry(0.034, 0.03, 0.06, 14)), metal, 0.08, 0.085, 0);
    add(g, alongX(new THREE.CylinderGeometry(0.044, 0.03, 0.08, 14)), metal, 0.42, 0.085, 0);
    add(g, alongX(new THREE.CylinderGeometry(0.04, 0.04, 0.006, 14)), lens, 0.463, 0.085, 0);
    for (const x of [0.17, 0.32]) add(g, new THREE.BoxGeometry(0.025, 0.05, 0.04), metal, x, 0.05, 0);
    add(g, new THREE.BoxGeometry(0.12, 0.012, 0.05), accent, 0.56, -0.034, 0); // color strip under the handguard
    m.add(g);

    // Scope glint (shows when the empowered shot is ready)
    this.glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: glintTexture, color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.glint.position.set(0.48, 0.085, 0);
    this.glint.renderOrder = 10;
    this.glint.visible = false;
    g.add(this.glint);

    // ---- arms: solved each frame from shoulder to the hand holds on the rifle (two-bone IK)
    const armSeg = (r: number) => add(m, new THREE.CylinderGeometry(r, r * 0.9, 1, 10), shell);
    for (const side of [1, -1]) {
      this.arms.push({
        shoulder: new THREE.Vector3(0, SHOULDER_HEIGHT + 0.04, side * 0.25),
        upper: armSeg(0.055),
        fore: armSeg(0.048),
        elbow: add(m, new THREE.SphereGeometry(0.055, 10, 8), joint),
        hand: add(m, new THREE.SphereGeometry(0.05, 10, 8), joint),
        // Right hand on the pistol grip, left hand under the handguard.
        grip: side === 1 ? new THREE.Vector3(0.13, -0.06, 0.0) : new THREE.Vector3(0.52, -0.04, 0),
        pole: side === 1 ? new THREE.Vector3(-0.3, -1, 0.8) : new THREE.Vector3(0.1, -1, -0.7),
      });
    }
  }

  /** Called once per frame. */
  update(p: PlayerState, dt: number, frozen: boolean, time: number) {
    const k = (rate: number) => 1 - Math.exp(-rate * dt); // framerate-independent smoothing
    this.root.rotation.y = -p.aim;

    const speed = Math.hypot(p.vx, p.vz);
    const fwdX = Math.cos(p.aim), fwdZ = Math.sin(p.aim);
    // Velocity in the character's local frame.
    const localFwd = (p.vx * fwdX + p.vz * fwdZ) / config.sprintSpeed;
    const localSide = (-p.vx * fwdZ + p.vz * fwdX) / config.sprintSpeed;
    const rolling = p.stance === 'roll';

    if (!frozen) {
      this.lean.x += ((rolling ? 0 : localFwd * 0.28) - this.lean.x) * k(10);
      this.lean.y += ((rolling ? 0 : localSide * 0.28) - this.lean.y) * k(10);
      this.bob += dt * (6 + speed * 1.6) * (speed > 0.3 ? 1 : 0);
      this.kneel += ((p.stance === 'kneel' ? 1 : 0) - this.kneel) * k(16);
      this.gunDown += ((p.stance === 'sprint' || rolling || p.gunRaiseTicks > 0 ? 1 : 0) - this.gunDown) * k(rolling ? 18 : 10);
      this.recoil = Math.max(0, this.recoil - dt * 5);
      this.tuck += ((rolling ? 1 : 0) - this.tuck) * k(rolling ? 22 : 9);
      this.land = Math.max(0, this.land - dt / 0.28);
      this.glintBurst = Math.max(0, this.glintBurst - dt / 0.35);
      const moving = speed > 0.3 && !rolling;
      this.walk += ((moving ? Math.min(1, speed / config.walkSpeed) : 0) - this.walk) * k(8);
      if (moving) {
        const n = Math.hypot(localFwd, localSide) || 1;
        this.stepDir.x += (localFwd / n - this.stepDir.x) * k(12);
        this.stepDir.y += (localSide / n - this.stepDir.y) * k(12);
      }
    }

    // ---- roll flip around the hips, along the roll direction.
    if (rolling) {
      const total = secToTicks(config.rollTime);
      this.rollSpin = (1 - p.rollTicks / total) * TAU;
      // Aim can turn mid-roll, so the axis is recomputed in the current local frame.
      this.rollAxis.set(p.rollDirX * fwdX + p.rollDirZ * fwdZ, -p.rollDirX * fwdZ + p.rollDirZ * fwdX);
    } else {
      if (this.wasRolling) {
        // The flip ends a full turn round: settle to the nearest upright angle, not back through the turn.
        this.rollSpin %= TAU;
        if (this.rollSpin > Math.PI) this.rollSpin -= TAU;
        this.land = 1;
      }
      this.rollSpin += (0 - this.rollSpin) * k(14);
    }
    this.wasRolling = rolling;
    this.pivot.rotation.set(this.rollSpin * this.rollAxis.y, 0, -this.rollSpin * this.rollAxis.x);
    // Tucked into a ball while rolling, lifted so the head clears the floor when upside down.
    this.pivot.position.y = PIVOT_Y;
    this.pivot.scale.setScalar(1 - 0.22 * this.tuck);

    // ---- body: lean into movement, crouch on landing and kneel, step bob.
    const landEase = this.land * this.land * (3 - 2 * this.land); // smoothstep: soft in, soft out
    const crouch = this.kneel * THIGH + landEase * 0.14 - this.tuck * 0.18;
    const bobY = Math.abs(Math.sin(this.bob)) * 0.05 * this.walk;
    this.body.position.y = bobY - crouch;
    this.body.rotation.set(this.lean.y, 0, -this.lean.x - landEase * 0.12);

    // ---- legs
    const walkAmt = this.walk * (1 - this.kneel) * (1 - this.tuck);
    this.legs.forEach((leg, i) => {
      const sign = i === 0 ? 1 : -1; // i 0 = left leg
      const swing = Math.sin(this.bob) * sign * 0.6 * walkAmt;
      const liftPhase = Math.max(0, Math.cos(this.bob) * sign);
      const dir = this.stepDir;
      // Pose terms (forward pitch = +rotation.z on the hip, knees bend with -rotation.z).
      let hipPitch = 0.45 * this.tuck * 2.6 + landEase * 0.55;
      let kneeBend = -2.1 * this.tuck - landEase * 1.0 - liftPhase * 0.9 * walkAmt;
      // Kneel: left foot planted in front, right knee on the ground.
      if (i === 0) { hipPitch += 1.45 * this.kneel; kneeBend += -1.45 * this.kneel; }
      else { hipPitch += -0.05 * this.kneel; kneeBend += -1.5 * this.kneel; }
      leg.hip.rotation.set(-swing * dir.y, 0, swing * dir.x + hipPitch);
      leg.knee.rotation.z = kneeBend;
      leg.ankle.rotation.z = -(hipPitch + kneeBend + swing * dir.x) * 0.85; // keep the boot roughly flat
    });

    // ---- rifle: lowered when sprinting or rolling, kicked back on recoil.
    const kick = Math.min(1.6, this.recoil);
    this.gun.rotation.z = -this.gunDown * 0.85 + kick * 0.22;
    this.gun.position.x = 0.02 - kick * 0.1;
    this.gun.position.y = SHOULDER_HEIGHT + (p.ads ? 0.02 : 0);
    this.gun.updateMatrix();
    for (const arm of this.arms) this.solveArm(arm);

    // ---- scope glint: steady twinkle while the empowered shot is ready, a flare when it arrives.
    const ready = isCharged(p);
    const building = chargeProgress(p);
    const twinkle = 0.85 + Math.sin(time * 9) * 0.15;
    const size = ready ? 0.55 * twinkle + this.glintBurst * 1.3 : building * 0.18;
    this.glint.visible = size > 0.02;
    this.glint.scale.setScalar(size);
    this.glint.material.rotation = time * 1.5;
    this.glint.material.opacity = ready ? 1 : 0.5 * building;

    // ---- hit flash
    this.flash = Math.max(0, this.flash - (frozen ? dt * 0.3 : dt));
    this.materials.forEach((mat, i) => {
      mat.emissive.setHex(this.flash > 0 ? 0xffffff : this.color);
      mat.emissiveIntensity = this.flash > 0 ? 3 : i === 0 ? 0.12 : 0.6;
    });
  }

  /** Two-bone IK from the shoulder to a hold point on the rifle, both in model space. */
  private solveArm(arm: Arm) {
    const s = arm.shoulder;
    const h = arm.grip.clone().applyMatrix4(this.gun.matrix);
    const toHand = h.clone().sub(s);
    const d = Math.min(toHand.length(), (UPPER_ARM + FOREARM) * 0.999);
    const dir = toHand.normalize();
    const cosA = (UPPER_ARM * UPPER_ARM + d * d - FOREARM * FOREARM) / (2 * UPPER_ARM * d);
    const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const perp = arm.pole.clone().sub(dir.clone().multiplyScalar(arm.pole.dot(dir))).normalize();
    const elbow = s.clone().addScaledVector(dir, Math.cos(a) * UPPER_ARM).addScaledVector(perp, Math.sin(a) * UPPER_ARM);
    const hand = s.clone().addScaledVector(dir, d);
    placeSegment(arm.upper, s, elbow);
    placeSegment(arm.fore, elbow, hand);
    arm.elbow.position.copy(elbow);
    arm.hand.position.copy(hand);
  }
}

function placeSegment(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  const v = b.clone().sub(a);
  const len = v.length();
  mesh.position.copy(a).addScaledVector(v, 0.5);
  mesh.quaternion.setFromUnitVectors(Y_AXIS, v.divideScalar(len || 1));
  mesh.scale.set(1, len, 1);
}

/** A four-point star with a soft core, drawn once and shared by every scope glint. */
export function makeGlintTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const core = g.createRadialGradient(64, 64, 0, 64, 64, 40);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.25, 'rgba(255,250,230,0.8)');
  core.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'lighter';
  const ray = (angle: number, length: number, width: number) => {
    g.save();
    g.translate(64, 64);
    g.rotate(angle);
    const grad = g.createLinearGradient(-length, 0, length, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-length, 0); g.lineTo(0, -width); g.lineTo(length, 0); g.lineTo(0, width);
    g.closePath();
    g.fill();
    g.restore();
  };
  ray(0, 64, 4);
  ray(Math.PI / 2, 64, 4);
  ray(Math.PI / 4, 34, 2.5);
  ray(-Math.PI / 4, 34, 2.5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
