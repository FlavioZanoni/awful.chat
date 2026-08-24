import { describe, expect, it } from "vitest";
import { serialize, humanize, mentionsMe } from "./mentions";

describe("mentions", () => {
  describe("serialize", () => {
    it("replaces @Name with @[did] tokens", () => {
      const nameToDidMap = new Map([["Alice", "did:key:z6MkAlice"]]);
      const input = "Hey @Alice, how are you?";
      const result = serialize(input, nameToDidMap);
      expect(result).toBe("Hey @[did:key:z6MkAlice], how are you?");
    });

    it("handles multiple mentions", () => {
      const nameToDidMap = new Map([
        ["Alice", "did:key:z6MkAlice"],
        ["Bob", "did:key:z6MkBob"],
      ]);
      const input = "@Alice and @Bob, let's chat";
      const result = serialize(input, nameToDidMap);
      expect(result).toBe("@[did:key:z6MkAlice] and @[did:key:z6MkBob], let's chat");
    });

    it("processes names in longest-first order to avoid prefix collisions", () => {
      const nameToDidMap = new Map([
        ["Ana", "did:key:z6MkAna"],
        ["Anna", "did:key:z6MkAnna"],
      ]);
      const input = "@Anna and @Ana are here";
      const result = serialize(input, nameToDidMap);
      expect(result).toBe("@[did:key:z6MkAnna] and @[did:key:z6MkAna] are here");
    });

    it("does not replace unrecorded @mentions", () => {
      const nameToDidMap = new Map([["Alice", "did:key:z6MkAlice"]]);
      const input = "@Alice and @Charlie";
      const result = serialize(input, nameToDidMap);
      expect(result).toBe("@[did:key:z6MkAlice] and @Charlie");
    });

    it("ignores partial word matches", () => {
      const nameToDidMap = new Map([["Alice", "did:key:z6MkAlice"]]);
      const input = "@Alice @Alice-admin @Alice-bot";
      const result = serialize(input, nameToDidMap);
      // Only @Alice without suffix should be replaced
      expect(result).toBe("@[did:key:z6MkAlice] @Alice-admin @Alice-bot");
    });

    it("handles empty name-to-did map", () => {
      const input = "@Alice and @Bob";
      const result = serialize(input, new Map());
      expect(result).toBe("@Alice and @Bob");
    });

    it("round-trips: serialize then humanize", () => {
      const nameToDidMap = new Map([["Alice", "did:key:z6MkAlice"]]);
      const input = "Hey @Alice!";

      const serialized = serialize(input, nameToDidMap);
      expect(serialized).toBe("Hey @[did:key:z6MkAlice]!");

      const resolveName = (did: string) => {
        if (did === "did:key:z6MkAlice") return "Alice";
        return did.slice(0, 8);
      };

      const humanized = humanize(serialized, resolveName);
      expect(humanized).toContain("@Alice");
      expect(humanized).toContain("span");
      expect(humanized).toContain("primary");
    });
  });

  describe("humanize", () => {
    it("converts @[did] tokens to styled mention chips", () => {
      const resolveName = (did: string) => {
        if (did === "did:key:z6MkAlice") return "Alice";
        return did.slice(0, 8);
      };
      const input = "@[did:key:z6MkAlice] says hi";
      const result = humanize(input, resolveName);
      expect(result).toContain("@Alice");
      expect(result).toContain("span");
      expect(result).toContain("primary");
    });

    it("resolves unknown dids with a short prefix", () => {
      const resolveName = (did: string) => did.slice(0, 8);
      const input = "@[did:key:z6MkUnknown]";
      const result = humanize(input, resolveName);
      expect(result).toContain("@did:key:");
    });

    it("handles multiple mentions", () => {
      const resolveName = (did: string) => {
        if (did === "did:key:z6MkAlice") return "Alice";
        if (did === "did:key:z6MkBob") return "Bob";
        return did.slice(0, 8);
      };
      const input = "@[did:key:z6MkAlice] and @[did:key:z6MkBob]";
      const result = humanize(input, resolveName);
      expect(result).toContain("@Alice");
      expect(result).toContain("@Bob");
    });

    it("does not mangle content without mentions", () => {
      const resolveName = (did: string) => did.slice(0, 8);
      const input = "Just regular text with @-signs at words";
      const result = humanize(input, resolveName);
      // Should not contain mention chip markup for these
      expect(result).toContain("@-signs");
    });

    it("does not process inside code fences (does not implement code fence handling)", () => {
      // Note: Code fence exclusion is the responsibility of the caller
      // humanize is text-only and does not parse markdown/code blocks.
      // Integration happens in MsgRender where code/link processing already runs.
      const resolveName = (did: string) => "Alice";
      const input = "`@[did:key:z6MkAlice]` in code";
      const result = humanize(input, resolveName);
      // humanize will still replace it - code handling is in MsgRender
      expect(result).toContain("@Alice");
    });
  });

  describe("mentionsMe", () => {
    it("detects when content mentions my DID", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "@[did:key:z6MkMe] you got a message";
      expect(mentionsMe(content, selfDids)).toBe(true);
    });

    it("returns false when content does not mention me", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "@[did:key:z6MkOther] you got a message";
      expect(mentionsMe(content, selfDids)).toBe(false);
    });

    it("handles multiple self DIDs (identity did + transport selfId)", () => {
      const selfDids = ["did:key:z6MkIdentity", "12D3Ko...PeerId"];
      const content = "@[12D3Ko...PeerId] check this";
      expect(mentionsMe(content, selfDids)).toBe(true);
    });

    it("returns false for plain text @mentions", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "@Alice says hi";
      expect(mentionsMe(content, selfDids)).toBe(false);
    });

    it("returns false for no mentions at all", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "Just some text with no mentions";
      expect(mentionsMe(content, selfDids)).toBe(false);
    });

    it("handles multiple mentions and finds me among others", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "@[did:key:z6MkAlice] @[did:key:z6MkMe] @[did:key:z6MkBob]";
      expect(mentionsMe(content, selfDids)).toBe(true);
    });
  });
});

describe("humanize escaping", () => {
  it("escapes peer-controlled names before they reach @html", () => {
    const out = humanize("@[did:key:zEvil]", () => "<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
});
