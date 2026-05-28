// Canonical item record + integrity commitment.
// payload_hash = sha256(canonical JSON of the content record). No salt: the board
// is public, so the hash is for tamper-evidence, not secrecy.
import { createHash } from "node:crypto";

export interface ItemContent {
  v: 1;
  domain: string;
  title: string;
  body: string;
  links: string[];
}

// Deterministic JSON: recursively sorted keys, no insignificant whitespace.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return "0x" + createHash("sha256").update(data).digest("hex");
}

export function buildCommitment(content: ItemContent): { canonical: string; payloadHash: string } {
  const canonical = stableStringify(content);
  return { canonical, payloadHash: sha256Hex(canonical) };
}

// Verify that displayed content matches an on-chain payload_hash.
export function verifyContent(content: ItemContent, onchainHash: string): boolean {
  const { payloadHash } = buildCommitment(content);
  return payloadHash.toLowerCase() === onchainHash.toLowerCase();
}
