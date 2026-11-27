# Iso Snipers

An isometric 1v1 sniper duel. Couch play first (keyboard + mouse and controllers at the same time), online later.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # simulation tests
npm run build    # static build in dist/, host anywhere
```

## Controls

| Action | Keyboard + mouse | Controller |
| --- | --- | --- |
| Move | WASD | Left stick |
| Aim | Mouse | Right stick |
| Focus (ADS, red laser) | Hold right click | Hold LT / L2 |
| Shoot | Left click | RT / R2 |
| Sprint | Hold Shift | Hold LB / L1 (or click L3) |
| Roll | Space | A / Cross |
| Rematch / practice vs dummy | Enter | Start |
| Fullscreen | F | |
| Free the mouse (it is captured while you play) | Esc | |
| Tuning panel | ` | |

Press any button on a device to join. With one player joined, press Enter or Start to practice against a dummy.

## Rules (first playable)

- 3 HP each. A shot deals 1 HP; hold focus for 0.75 s and the next shot deals 2 HP.
- Focused shots go exactly down the laser. Hip-fire spreads inside an 8 degree cone, drawn as the cone cursor.
- One round in the chamber: 1.2 s bolt cycle after every shot (grey ring under you).
- Sprinting lowers the gun. Rolling straight into focus drops you into a kneel: you stay planted, your hitbox shrinks and the charge takes 0.5 s. Let go of focus to stand.
- First to 3 rounds wins.

All numbers live in `src/config.ts` and can be changed live from the tuning panel.

## Code layout

```
src/
  config.ts          every tunable number
  sim/               the game rules: pure, deterministic, no DOM (runs headless or on a server)
    sim.ts           step(state, commands) at a fixed 60 ticks per second
    arena.ts         layout, collision, raycasts
    types.ts         plain-data state and the per-tick Command
  input/             devices -> Command (keyboard+mouse, gamepads, join order)
  render/            Three.js scene, HUD, placeholder WebAudio sounds; reads state only
  dev/tuning.ts      live tuning panel
tests/sim.test.ts    rules and determinism tests
```

The simulation never reads a device or a clock. Online play adds a network input
source and a server running the same `sim/` code.
