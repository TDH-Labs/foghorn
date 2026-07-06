export interface PlatformSpec {
  name: string;
  maxChars: number;
  maxMedia: number;
  maxHashtags: number;
  maxMentions: number;
  /** gate-cadence daily limit (soft, human-like) */
  maxPerDay: number;
  /** publisher hard ceiling, independent of gates (belt + suspenders) */
  hardDailyCeiling: number;
  minGapHours: number;
}

export const PLATFORMS: Record<string, PlatformSpec> = {
  x: {
    name: "x",
    maxChars: 280,
    maxMedia: 4,
    maxHashtags: 3,
    maxMentions: 2,
    maxPerDay: 3,
    hardDailyCeiling: 10,
    minGapHours: 3,
  },
  linkedin: {
    name: "linkedin",
    maxChars: 3000,
    maxMedia: 9,
    maxHashtags: 5,
    maxMentions: 3,
    maxPerDay: 1,
    hardDailyCeiling: 3,
    minGapHours: 20,
  },
  nostr: {
    name: "nostr",
    maxChars: 5000,
    maxMedia: 4,
    maxHashtags: 6,
    maxMentions: 4,
    maxPerDay: 5,
    hardDailyCeiling: 20,
    minGapHours: 1,
  },
};

export function platformSpec(platform: string): PlatformSpec {
  const spec = PLATFORMS[platform];
  if (!spec) throw new Error(`unknown platform: ${platform}`);
  return spec;
}
