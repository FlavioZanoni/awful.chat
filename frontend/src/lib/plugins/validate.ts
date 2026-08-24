/**
 * Plugin validation logic - pure functions, no side effects.
 * Host-side validation on receive mirrors profile-meta pattern.
 */

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const PLUGIN_ID_RE = /^[a-z0-9-]{2,32}$/;
const CARD_MAX_BYTES = 16 * 1024; // 16 KB
const UPDATE_MAX_BYTES = 4 * 1024; // 4 KB
const EPHEMERAL_MAX_BYTES = 4 * 1024; // 4 KB

export function validatePluginId(pluginId: unknown): ValidationResult {
  if (typeof pluginId !== "string") {
    return { ok: false, reason: "pluginId must be string" };
  }
  if (!PLUGIN_ID_RE.test(pluginId)) {
    return { ok: false, reason: "pluginId does not match ^[a-z0-9-]{2,32}$" };
  }
  return { ok: true };
}

export function validateCardPayload(data: unknown): ValidationResult {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return { ok: false, reason: "card payload not JSON serializable" };
  }
  if (json.length > CARD_MAX_BYTES) {
    return {
      ok: false,
      reason: `card payload ${json.length} bytes exceeds 16 KB limit`,
    };
  }
  return { ok: true };
}

export function validateUpdatePayload(data: unknown): ValidationResult {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return { ok: false, reason: "update payload not JSON serializable" };
  }
  if (json.length > UPDATE_MAX_BYTES) {
    return {
      ok: false,
      reason: `update payload ${json.length} bytes exceeds 4 KB limit`,
    };
  }
  return { ok: true };
}

export function validateEphemeralPayload(data: unknown): ValidationResult {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return { ok: false, reason: "ephemeral payload not JSON serializable" };
  }
  if (json.length > EPHEMERAL_MAX_BYTES) {
    return {
      ok: false,
      reason: `ephemeral payload ${json.length} bytes exceeds 4 KB limit`,
    };
  }
  return { ok: true };
}
