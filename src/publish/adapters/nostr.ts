// Nostr adapter: NIP-01 kind-1 notes signed locally, published to relays over
// WebSocket. Zero cost, no gatekeeping — the designated shadow/e2e target.
// Delete is NIP-09 (kind 5), best-effort by protocol design.

import { finalizeEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import type { OwnPost, PlatformAdapter, PostReceipt } from "./adapter.ts";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

export type RelaySender = (relayUrl: string, event: Event) => Promise<boolean>;

/** Send ["EVENT", ...] and await ["OK", id, true] (10s timeout per relay). */
export const wsSender: RelaySender = (relayUrl, event) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* closed */ }
        resolve(ok);
      }
    };
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => done(false), 10_000);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data)) as unknown[];
        if (data[0] === "OK" && data[1] === event.id) {
          clearTimeout(timer);
          done(data[2] === true);
        }
      } catch { /* ignore non-json frames */ }
    };
    ws.onerror = () => { clearTimeout(timer); done(false); };
  });

function secretKeyFromEnv(): Uint8Array {
  const nsec = process.env.NOSTR_NSEC;
  if (!nsec) throw new Error("NOSTR_NSEC not set");
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error(`expected nsec, got ${decoded.type}`);
  return decoded.data;
}

export class NostrAdapter implements PlatformAdapter {
  readonly platform = "nostr";
  private readonly sk: Uint8Array;
  private readonly relays: string[];
  private readonly send: RelaySender;

  constructor(opts: { secretKey?: Uint8Array; relays?: string[]; send?: RelaySender } = {}) {
    this.sk = opts.secretKey ?? secretKeyFromEnv();
    this.relays = opts.relays ?? DEFAULT_RELAYS;
    this.send = opts.send ?? wsSender;
  }

  signNote(text: string): Event {
    const template: EventTemplate = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: text,
    };
    return finalizeEvent(template, this.sk);
  }

  private async broadcast(event: Event): Promise<number> {
    const results = await Promise.all(this.relays.map((r) => this.send(r, event).catch(() => false)));
    return results.filter(Boolean).length;
  }

  async post(canonicalBytes: Uint8Array, mediaRefs: string[]): Promise<PostReceipt> {
    if (mediaRefs.length > 0) throw new Error("nostr adapter: media not implemented yet (fail closed)");
    const event = this.signNote(new TextDecoder().decode(canonicalBytes));
    const accepted = await this.broadcast(event);
    if (accepted === 0) throw new Error(`no relay accepted event ${event.id}`);
    return { externalId: event.id, url: `https://njump.me/${nip19.noteEncode(event.id)}` };
  }

  async delete(externalId: string): Promise<void> {
    const template: EventTemplate = {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["e", externalId]],
      content: "post retracted",
    };
    await this.broadcast(finalizeEvent(template, this.sk)); // NIP-09 is best-effort
  }

  async verifyOwn(): Promise<OwnPost[]> {
    return []; // relay REQ query is a later enhancement; X path is the read-back exemplar
  }
}
