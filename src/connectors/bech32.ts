// Minimal bech32 decoder (BIP-173) for Nostr nsec/npub validation.
// Checksum-verified decode + 5->8 bit regroup. Encoding lives with the
// Phase-6 nostr adapter; validation only needs decode.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

export function bech32Decode(str: string): { hrp: string; data: Uint8Array } {
  const lowered = str.toLowerCase();
  if (str !== lowered && str !== str.toUpperCase()) throw new Error("bech32: mixed case");
  const pos = lowered.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lowered.length) throw new Error("bech32: bad separator position");
  const hrp = lowered.slice(0, pos);
  const values: number[] = [];
  for (const c of lowered.slice(pos + 1)) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) throw new Error(`bech32: invalid character '${c}'`);
    values.push(idx);
  }
  if (polymod([...hrpExpand(hrp), ...values]) !== 1) throw new Error("bech32: checksum mismatch");

  // regroup 5-bit words (minus 6 checksum words) into bytes
  const words = values.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc << (8 - bits)) & 0xff) {
    if (bits >= 5) throw new Error("bech32: excess padding");
  }
  return { hrp, data: new Uint8Array(bytes) };
}
