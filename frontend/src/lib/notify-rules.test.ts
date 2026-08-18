import { describe, it, expect } from "vitest";
import { shouldPlayMessageSound } from "./notify-rules";

describe("shouldPlayMessageSound", () => {
  it("stays silent while reading the conversation with focus", () => {
    expect(
      shouldPlayMessageSound({ enabled: true, viewingConversation: true, focused: true })
    ).toBe(false);
  });

  it("plays when the message lands in another conversation", () => {
    expect(
      shouldPlayMessageSound({ enabled: true, viewingConversation: false, focused: true })
    ).toBe(true);
  });

  it("plays when the window is unfocused, even on the open conversation", () => {
    expect(
      shouldPlayMessageSound({ enabled: true, viewingConversation: true, focused: false })
    ).toBe(true);
  });

  it("never plays when switched off", () => {
    expect(
      shouldPlayMessageSound({ enabled: false, viewingConversation: false, focused: false })
    ).toBe(false);
  });
});
