// Build the adapter map from whatever credentials exist. A platform without
// working creds simply has no adapter — the publisher holds its rows with a
// visible reason instead of failing silently.

import type { PlatformAdapter } from "./adapter.ts";
import { LinkedInAdapter } from "./linkedin.ts";
import { NostrAdapter } from "./nostr.ts";
import { XAdapter } from "./x.ts";

export function createAdapters(): Map<string, PlatformAdapter> {
  const adapters = new Map<string, PlatformAdapter>();
  const attempts: [string, () => PlatformAdapter][] = [
    ["x", () => new XAdapter()],
    ["nostr", () => new NostrAdapter()],
    ["linkedin", () => new LinkedInAdapter()],
  ];
  for (const [name, make] of attempts) {
    try {
      adapters.set(name, make());
    } catch {
      // missing creds — publisher will hold rows for this platform with a reason
    }
  }
  return adapters;
}
