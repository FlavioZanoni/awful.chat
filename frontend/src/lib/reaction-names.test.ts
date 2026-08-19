import { describe, expect, it } from "vitest";
import { formatReactorNames } from "./reaction-names";

describe("formatReactorNames", () => {
  it("lists few reactors plainly, self first", () => {
    expect(formatReactorNames(["Ana", "Bo"], true)).toBe("You, Ana, Bo");
  });

  it("caps at four names and folds the rest", () => {
    expect(formatReactorNames(["A", "B", "C", "D", "E"], false)).toBe(
      "A, B, C, D and 1 other"
    );
    expect(formatReactorNames(["A", "B", "C", "D", "E", "F"], true)).toBe(
      "You, A, B, C and 3 others"
    );
  });
});
