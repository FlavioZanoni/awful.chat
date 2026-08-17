/**
 * Should somebody else joining or leaving a call make a sound for us?
 *
 * Pure so the awkward parts are testable: presence is rebroadcast to every
 * peer on connect, so without the transition check a late joiner would set off
 * one chime per person already in the call, and calls in other rooms must stay
 * silent.
 */
export interface PeerCallChimeInput {
  /** Are we in a call at all? Nothing chimes if we are not. */
  imInCall: boolean;
  /** The room our own call is in. */
  myCallRoom: string | null;
  /** The room the other person's call is in, if known. */
  room: string | undefined;
  /** Did we already have them in the call before this message? */
  wasInCall: boolean;
  /** Are they in the call after it? */
  nowInCall: boolean;
}

export function peerCallChime(
  input: PeerCallChimeInput
): "join" | "leave" | null {
  if (!input.imInCall) return null;
  if (!input.room || input.room !== input.myCallRoom) return null;
  if (input.nowInCall && !input.wasInCall) return "join";
  if (!input.nowInCall && input.wasInCall) return "leave";
  return null;
}
