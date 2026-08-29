import { describe, expect, it } from "vitest";
import {
  extensionOf,
  highlightLanguage,
  previewKind,
  MAX_PREVIEW_BYTES,
} from "./text-preview";

describe("extensionOf", () => {
  it("takes the last extension", () => {
    expect(extensionOf("notes.tar.md")).toBe("md");
  });

  it("lowercases", () => {
    expect(extensionOf("README.MD")).toBe("md");
  });

  it("treats a bare dotfile as its own name", () => {
    expect(extensionOf("Dockerfile")).toBe("dockerfile");
  });
});

describe("previewKind", () => {
  it("opens markdown as markdown", () => {
    for (const name of ["a.md", "a.mdx", "a.markdown", "README.MD"]) {
      expect(previewKind(name, "text/plain", 100)).toBe("markdown");
    }
  });

  it("trusts the extension over the mime type", () => {
    // A .md almost always arrives as text/plain or octet-stream, because the
    // browser guesses the type from the same extension we are reading.
    expect(previewKind("notes.md", "application/octet-stream", 100)).toBe(
      "markdown"
    );
  });

  it("opens known text files as text", () => {
    expect(previewKind("a.txt", "text/plain", 100)).toBe("text");
    expect(previewKind("a.json", "application/json", 100)).toBe("text");
  });

  it("falls back to the mime type for an unknown extension", () => {
    expect(previewKind("notes.weird", "text/plain", 100)).toBe("text");
  });

  it("refuses binaries", () => {
    expect(previewKind("cat.png", "image/png", 100)).toBeNull();
    expect(previewKind("a.zip", "application/zip", 100)).toBeNull();
  });

  it("refuses anything too big to hold as a string", () => {
    expect(previewKind("huge.txt", "text/plain", MAX_PREVIEW_BYTES + 1)).toBeNull();
    expect(previewKind("huge.md", "text/plain", MAX_PREVIEW_BYTES + 1)).toBeNull();
  });
});

describe("anything shiki can highlight is worth opening", () => {
  // The list is shiki's own, not a curated guess - a curated guess is what
  // left .vue, .svelte and .zig downloading instead of opening.
  it("opens source files a hand-written list would have missed", () => {
    for (const name of ["App.vue", "App.svelte", "main.zig", "a.nix", "b.hcl"]) {
      expect(previewKind(name, "application/octet-stream", 100)).toBe("text");
    }
  });

  it("still opens text that is not a language at all", () => {
    expect(previewKind("server.log", "application/octet-stream", 100)).toBe(
      "text"
    );
    expect(previewKind(".env", "application/octet-stream", 100)).toBe("text");
  });

  it("names a grammar only when there is one to name", () => {
    expect(highlightLanguage("main.rs")).toBe("rs");
    // shiki does have a log grammar, which is why .log highlights rather
    // than falling back to plain text.
    expect(highlightLanguage("server.log")).toBe("log");
    // .env and .srt are text with no grammar behind them: the viewer shows
    // them in a plain pre rather than fetching a chunk that does not exist.
    expect(highlightLanguage("a.env")).toBeNull();
    expect(highlightLanguage("subs.srt")).toBeNull();
  });

  it("leaves binaries alone", () => {
    expect(previewKind("a.png", "image/png", 100)).toBeNull();
    expect(previewKind("a.zip", "application/zip", 100)).toBeNull();
  });
});
