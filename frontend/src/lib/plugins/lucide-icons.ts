/**
 * Lazy lucide-by-name lookup for plugin manifest icons ("lucide:dices").
 *
 * Deliberately its own module: the aggregate `icons` import defeats
 * tree-shaking and weighs the whole icon set, so ONLY this chunk pays that
 * cost, and it loads the first time a lucide: icon actually renders.
 * Instances whose plugins stick to emoji never download it.
 */
import { icons } from "@lucide/svelte";
import type { Component } from "svelte";

export function lucideByName(kebab: string): Component | null {
  const pascal = kebab
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return ((icons as Record<string, unknown>)[pascal] as Component) ?? null;
}
