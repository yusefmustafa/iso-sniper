import GUI from 'lil-gui';
import { config } from '../config';

/** Live tuning panel (press ` to toggle). Every number in config.ts, changeable mid-match. */
export function createTuningPanel() {
  const gui = new GUI({ title: 'Tuning (`)' });
  const groups: Record<string, (keyof typeof config)[]> = {
    Movement: ['walkSpeed', 'sprintSpeed', 'adsSpeed', 'accelTime', 'stopTime', 'sprintRampTime', 'gunRaiseTime'],
    Roll: ['rollDistance', 'rollTime', 'rollCooldown', 'rollEndSpeedFactor', 'kneelWindow'],
    Shooting: ['hipSpreadDeg', 'boltTime', 'chargeTime', 'kneelChargeTime', 'inputBuffer'],
    'Hit feel': ['hitstopFrames', 'chargedHitstopFrames', 'knockback', 'knockbackTime', 'finalShotSlowmo', 'finalShotSlowmoTime'],
    Match: ['maxHp', 'chargedDamage', 'roundsToWin'],
  };
  const ints = new Set(['hitstopFrames', 'chargedHitstopFrames', 'maxHp', 'chargedDamage', 'roundsToWin']);
  for (const [name, keys] of Object.entries(groups)) {
    const f = gui.addFolder(name);
    for (const k of keys) {
      const v = config[k] as number;
      const c = f.add(config, k, 0, Math.max(1, v * 3));
      if (ints.has(k)) c.step(1);
    }
    if (name !== 'Shooting') f.close();
  }
  gui.add({ copy: () => navigator.clipboard?.writeText(JSON.stringify(config, null, 2)) }, 'copy').name('Copy values as JSON');
  gui.hide();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') gui.show(gui._hidden);
  });
  return gui;
}
