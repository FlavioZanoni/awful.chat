import { describe, expect, it } from "vitest";
import { convertTargets, withExtension } from "./image-convert";

describe("convertTargets", () => {
  it("never offers the format the image already is", () => {
    // That is what the Original entry does, losslessly and for free.
    expect(convertTargets("image/png").map((t) => t.label)).toEqual([
      "JPEG",
      "WebP",
    ]);
    expect(convertTargets("image/webp").map((t) => t.label)).toEqual([
      "PNG",
      "JPEG",
    ]);
  });

  it("offers PNG for a GIF, which is the still-frame case", () => {
    expect(convertTargets("image/gif").map((t) => t.label)).toEqual([
      "PNG",
      "JPEG",
      "WebP",
    ]);
  });

  it("treats image/jpg as image/jpeg", () => {
    // Not a real mime type, but people and some tools emit it, and without
    // this the menu offers converting a JPEG to a JPEG.
    expect(convertTargets("image/jpg").map((t) => t.label)).toEqual([
      "PNG",
      "WebP",
    ]);
  });

  it("offers nothing for what is not an image", () => {
    expect(convertTargets("text/plain")).toEqual([]);
    expect(convertTargets("")).toEqual([]);
  });

  it("never offers AVIF, which browsers cannot encode", () => {
    expect(convertTargets("image/png").some((t) => t.mime.includes("avif"))).toBe(
      false
    );
  });
});

describe("withExtension", () => {
  it("replaces the extension", () => {
    expect(withExtension("cat.png", "jpg")).toBe("cat.jpg");
  });

  it("keeps dots inside the name", () => {
    expect(withExtension("my.holiday.photo.png", "webp")).toBe(
      "my.holiday.photo.webp"
    );
  });

  it("appends when there is no extension", () => {
    expect(withExtension("screenshot", "png")).toBe("screenshot.png");
  });

  it("does not eat a name that is only an extension", () => {
    expect(withExtension(".gitignore", "png")).toBe("image.png");
  });
});
