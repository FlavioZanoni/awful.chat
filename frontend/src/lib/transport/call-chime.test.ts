import { describe, it, expect } from "vitest";
import { peerCallChime } from "./call-chime";

const base = {
  imInCall: true,
  myCallRoom: "room1",
  room: "room1",
  wasInCall: false,
  nowInCall: true,
};

describe("peerCallChime", () => {
  it("chimes when someone joins the call we are in", () => {
    expect(peerCallChime(base)).toBe("join");
  });

  it("chimes when someone leaves the call we are in", () => {
    expect(
      peerCallChime({ ...base, wasInCall: true, nowInCall: false })
    ).toBe("leave");
  });

  // Presence is rebroadcast to every peer on connect. Without this, joining a
  // call with four people in it would fire four chimes at once.
  it("stays silent when the presence message changes nothing", () => {
    expect(peerCallChime({ ...base, wasInCall: true, nowInCall: true })).toBeNull();
    expect(
      peerCallChime({ ...base, wasInCall: false, nowInCall: false })
    ).toBeNull();
  });

  it("stays silent for a call happening in another room", () => {
    expect(peerCallChime({ ...base, room: "room2" })).toBeNull();
    expect(
      peerCallChime({ ...base, room: "room2", wasInCall: true, nowInCall: false })
    ).toBeNull();
  });

  it("stays silent when we are not in a call ourselves", () => {
    expect(peerCallChime({ ...base, imInCall: false })).toBeNull();
  });

  it("stays silent when the room is unknown", () => {
    expect(peerCallChime({ ...base, room: undefined })).toBeNull();
    expect(peerCallChime({ ...base, myCallRoom: null })).toBeNull();
  });
});
