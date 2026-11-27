# Iso Snipers

An isometric 1v1 sniper duel, played online in the browser. Create a match, send the link, your friend clicks it and you duel.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # simulation tests
npm run build    # static build in dist/, host anywhere
```

To try online play on one machine, open two tabs at `http://localhost:5173/?net=local`
(BroadcastChannel instead of WebRTC). Real WebRTC between two isolated browsers:
`npm run relay` (local signaling relay) and `npm run smoke:online` with the dev server running.

Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`). Turn it on once
under the repo's Settings > Pages > Source: GitHub Actions.

## Controls

| Action | Keyboard + mouse | Controller |
| --- | --- | --- |
| Move | WASD | Left stick |
| Aim | Mouse | Right stick |
| Focus (ADS, red laser) | Hold right click | Hold LT / L2 |
| Shoot | Left click | RT / R2 |
| Sprint | Hold Shift | Hold LB / L1 (or click L3) |
| Roll | Space | A / Cross |
| Rematch | Enter | Start |
| Fullscreen | F | |
| Free the mouse (it is captured while you play); then click Leave match to quit | Esc | |
| Tuning panel (practice only) | ` | |

Keyboard + mouse and controllers both work; whichever you touched last drives your player. Practice vs dummy is on the front screen.

## Rules (first playable)

- 3 HP each. A shot deals 1 HP. The empowered 2 HP shot only comes from rolling into focus (see kneel below); standing focus is accurate but never empowered.
- Focused shots go exactly down the laser. Hip-fire spreads inside an 8 degree cone, drawn as the cone cursor.
- One round in the chamber: 1.2 s bolt cycle after every shot (grey ring under you).
- Sprinting lowers the gun. Rolling straight into focus while still holding roll drops you into a kneel: you stay planted, your hitbox shrinks and the empowered shot charges in 0.5 s (the scope glints when it's ready). Firing it kicks you back about 0.8 m and stands you up. Let go of focus or roll to stand.
- Settings (top left while the mouse is free, or F2 any time): the hip-fire cone can stop at the cursor or run on to the wall.
  A Dev section has live feel toggles: roll direction (where you move / toward the cursor; a game rule, the
  match creator's choice applies online), sprint facing (snap / turn / keep facing the cursor) and the sprint
  rifle carry (across the chest / low ready / one hand).
- Getting hit cancels your focus and any charge (empowered shot included), stuns you for 0.25 s (no moving, shooting
  or rolling) and pushes you back, then you're invulnerable for 3 s (you blink white). Focus needs a fresh press after a hit.
  You can still shoot while invulnerable; shots that hit you stop in a white burst and do nothing.
- First to 3 rounds wins.

All numbers live in `src/config.ts` and can be changed live from the tuning panel.

## Online play

Peer-to-peer rollback netcode, no game server:

- **Finding each other:** the match link is `…/#<room>`. [Trystero](https://github.com/dmotz/trystero) uses public
  Nostr relays to exchange WebRTC offers, then the two browsers talk directly. Hosting is a static site, cost $0.
- **Rollback:** both browsers run the full sim. Your input applies after a 2-frame delay (33 ms, `?delay=N`
  to change). The opponent's input is predicted (they keep doing what they last did); when their real input
  arrives and differs, the sim rewinds to that frame and replays to now. Up to 8 frames of prediction, then it waits.
- **Shots:** hitscan is resolved inside the sim on the frame it was fired, so the shooter's laser is the truth.
- **Time sync:** the peer that runs ahead skips a tick now and then so neither side rolls back more than needed.
- **Determinism:** the sim uses its own sin/cos/atan2 (`sim/dmath.ts`) so Chrome, Firefox and Safari compute
  identical bits, and inputs are quantized to small integers on the wire. Every 60 frames the peers compare a
  state hash; a mismatch shows a DESYNC warning in the corner.
- **Smoothing:** a rollback correction to a player's position is blended out over ~60 ms instead of snapping.
- **Tuning:** the host's tuning values are sent at match start; the panel is locked during online matches.
- **Limits:** no TURN relay yet, so a few strict networks (some corporate or mobile carriers) can't connect directly.
  P2P means no cheat protection; fine for playing with friends.

## Code layout

```
src/
  config.ts          every tunable number
  sim/               the game rules: pure, deterministic, no DOM (runs headless or on a server)
    sim.ts           step(state, commands) at a fixed 60 ticks per second
    arena.ts         layout, collision, raycasts
    types.ts         plain-data state and the per-tick Command
    dmath.ts         deterministic trig for cross-browser lockstep
  net/               online play
    rollback.ts      rollback session: prediction, rewind/replay, time sync, desync check
    webrtc.ts        Trystero + WebRTC transport (reliable handshake, unreliable input channel)
    handshake.ts     who is P1, seed and config exchange
    channel.ts       transport interface, BroadcastChannel and fake-latency transports
    codec.ts         Command <-> small integers on the wire
  input/             devices -> Command (keyboard+mouse, gamepads)
  render/            Three.js scene, HUD, placeholder WebAudio sounds; reads state only
  dev/tuning.ts      live tuning panel
tests/               rules, determinism and rollback tests (80 ms latency, jitter, 10% loss)
tools/               local Nostr relay and a two-browser WebRTC smoke test
```

The simulation never reads a device or a clock, which is what makes rollback possible.
