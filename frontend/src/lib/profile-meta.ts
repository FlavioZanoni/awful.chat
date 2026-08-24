/**
 * Profile metadata validation and sanitization.
 * Used at the trust boundary (receiving wire profiles) and by ProfileSettings.
 */

export interface ValidatedProfileMeta {
  tagText?: string;
  tagTextColor?: string;
  tagChipColor?: string;
  bio?: string;
  nameEffect?: string;
  bannerUrl?: string;
}

/**
 * Validate and sanitize profile metadata from wire or settings.
 * Strict validation at trust boundary: missing or invalid fields are dropped,
 * not substituted with defaults.
 */
export function validateProfileMeta(meta: Partial<ValidatedProfileMeta>): ValidatedProfileMeta {
  const result: ValidatedProfileMeta = {};

  // Tag: 2-5 chars, trimmed
  if (typeof meta.tagText === "string") {
    const trimmed = meta.tagText.trim().slice(0, 5);
    if (trimmed.length >= 2) {
      result.tagText = trimmed;
    }
  }

  // Bio: max 200 chars, plain text (no HTML)
  if (typeof meta.bio === "string") {
    const trimmed = meta.bio.slice(0, 200);
    if (trimmed.length > 0) {
      result.bio = trimmed;
    }
  }

  // Colors: hex format #RRGGBB
  const hexColorRegex = /^#[0-9a-fA-F]{6}$/;

  if (typeof meta.tagTextColor === "string" && hexColorRegex.test(meta.tagTextColor)) {
    result.tagTextColor = meta.tagTextColor;
  }

  if (typeof meta.tagChipColor === "string" && hexColorRegex.test(meta.tagChipColor)) {
    result.tagChipColor = meta.tagChipColor;
  }

  // Name effect: must be one of the enum values
  const validEffects = ["none", "gradient", "shimmer", "glow", "rainbow"];
  if (
    typeof meta.nameEffect === "string" &&
    validEffects.includes(meta.nameEffect)
  ) {
    result.nameEffect = meta.nameEffect;
  }

  // Banner URL: data:image only, max 1.5 MB string length
  if (typeof meta.bannerUrl === "string") {
    if (
      meta.bannerUrl.startsWith("data:image/") &&
      meta.bannerUrl.length <= 1_500_000
    ) {
      result.bannerUrl = meta.bannerUrl;
    }
  }

  return result;
}
