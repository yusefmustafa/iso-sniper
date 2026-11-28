import type { WireCmd } from './codec';
import type { Config } from '../config';

/** The messages peers send each other. Transports live in mesh.ts and webrtc.ts. */

export const PROTOCOL_VERSION = 3;

export type BotLevelName = 'easy' | 'normal' | 'hard';

/** A seat in the room, as the host announces it. A bot seat has no peer: the host plays it. */
export interface WireSlot { name: string; peer: string | null; bot: BotLevelName | null; ready: boolean; linked: boolean }

/** A seat in a starting match: who sends its inputs, and whether it is a bot. */
export interface StartSlot { name: string; owner: string; bot: BotLevelName | null }

export type NetMessage =
  // Pre-match room (see lobby.ts). The host owns the seats, names and ready flags.
  | { t: 'hello'; v: number; host: boolean; name: string }
  | { t: 'rename'; name: string }
  | { t: 'nameTaken' }
  | { t: 'ready'; ready: boolean }
  | { t: 'mesh'; peers: string[] } // a guest's direct connections, so the host only starts once everyone is linked
  | { t: 'lobby'; slots: (WireSlot | null)[] }
  | { t: 'start'; v: number; seed: number; config: Config; slots: StartSlot[] }
  | { t: 'go' }
  | { t: 'full'; playing?: boolean } // the room has no free seat, or a match is running
  | {
      t: 'in';
      /** Inputs per player slot the sender owns: [slot, frame of the first one, inputs for that frame and the ones after]. */
      c: [number, number, WireCmd[]][];
      ack: number[]; // per slot: the highest frame the sender has every input up to
      fr: number; // sender's current frame, for time sync
      ts: number; // sender's clock (ms)
      echo: number; // the last ts received from us
      hold: number; // ms between receiving `echo` and sending this
      h?: [number, number]; // [frame, state hash] for desync detection
      d: number; // how many player drops the sender has applied (hashes only compare at the same count)
      drops?: [number, number][]; // host only: every [slot, frame] where a player was replaced by a bot
    }
  | { t: 'bye' };
