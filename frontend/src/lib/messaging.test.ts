import { beforeAll, describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  canonicalContent,
  computeSharedSecret,
  encryptForRecipient,
  signMessage,
  verifyMessage,
  verifySignature,
} from "./messaging";
import {
  createIdentity,
  deriveKeypairFromMnemonic,
  generateMnemonic,
  publicKeyToDid,
  didToPublicKey,
  requireSession,
} from "./identity/identity";
import { MessageType, type Message } from "./types/message";
import { hex, unhex, utf8 } from "./utils";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "0198c0de-0000-7000-8000-000000000001",
    roomCode: "test-room",
    senderId: "sender",
    senderName: "Tester",
    timestamp: 1234567890,
    lamport: 7,
    type: MessageType.Text,
    content: "hello world",
    attachments: [],
    ...overrides,
  };
}

beforeAll(async () => {
  // Creates + unlocks a real identity backed by fake-indexeddb
  await createIdentity("correct horse battery staple");
});

describe("sign / verify", () => {
  it("signs and verifies a message round-trip", async () => {
    const signed = signMessage(makeMessage());
    expect(signed.sig).toBeTruthy();
    expect(signed.senderDid).toBe(requireSession().did);
    expect(await verifyMessage(signed)).toBe(true);
  });

  it("rejects tampered content", async () => {
    const signed = signMessage(makeMessage());
    const tampered = { ...signed, content: "evil" };
    expect(await verifyMessage(tampered)).toBe(false);
  });

  it("rejects a signature from a different identity", async () => {
    const signed = signMessage(makeMessage());
    const other = deriveKeypairFromMnemonic(generateMnemonic());
    const forged = { ...signed, senderDid: publicKeyToDid(other.publicKey) };
    expect(await verifyMessage(forged)).toBe(false);
  });

  it("rejects messages without sig or did", async () => {
    expect(await verifyMessage(makeMessage())).toBe(false);
  });

  it("returns false (not throw) on garbage input", async () => {
    expect(await verifySignature("did:key:zzz", "nothex", "content")).toBe(
      false
    );
  });

  it("excludes timestamp from the canonical form", () => {
    const a = makeMessage({ timestamp: 1 });
    const b = makeMessage({ timestamp: 999 });
    expect(canonicalContent(a)).toBe(canonicalContent(b));
  });

  it("covers reaction fields in v2 signatures", async () => {
    const signed = signMessage(
      makeMessage({
        type: MessageType.Reaction,
        content: "",
        reactionTo: "target-1",
        reactionEmoji: "👍",
        reactionOp: "add",
      })
    );
    expect(signed.sigV).toBe(2);
    expect(await verifyMessage(signed)).toBe(true);
    expect(await verifyMessage({ ...signed, reactionEmoji: "💀" })).toBe(false);
    expect(await verifyMessage({ ...signed, reactionOp: "remove" })).toBe(
      false
    );
    expect(await verifyMessage({ ...signed, reactionTo: "other" })).toBe(false);
  });

  it("covers file meta (infoHash) in v2 signatures", async () => {
    const meta = {
      files: [
        { filename: "a.png", mimeType: "image/png", size: 10, infoHash: "aa" },
      ],
    };
    const signed = signMessage(makeMessage({ meta }));
    expect(await verifyMessage(signed)).toBe(true);
    const swapped = {
      ...signed,
      meta: { files: [{ ...meta.files[0], infoHash: "bb" }] },
    };
    expect(await verifyMessage(swapped)).toBe(false);
  });

  it("still verifies legacy v1 signatures (no sigV)", async () => {
    const msg = makeMessage();
    const session = requireSession();
    const sig = hex(
      ed25519.sign(utf8(canonicalContent(msg)), session.privateKey)
    );
    const legacy = { ...msg, senderDid: session.did, sig };
    expect(await verifyMessage(legacy)).toBe(true);
    expect(await verifyMessage({ ...legacy, content: "evil" })).toBe(false);
  });
});

describe("DM encryption", () => {
  it("shared secret is hashed, not raw ECDH output", () => {
    const other = deriveKeypairFromMnemonic(generateMnemonic());
    const secret = computeSharedSecret(other.publicKey);
    const session = requireSession();
    const raw = x25519.getSharedSecret(
      ed25519.utils.toMontgomerySecret(session.privateKey),
      ed25519.utils.toMontgomery(other.publicKey)
    );
    expect(hex(secret)).not.toBe(hex(raw));
    expect(secret.length).toBe(32);
  });

  it("encrypts so the recipient's derived secret decrypts it", async () => {
    const recipient = deriveKeypairFromMnemonic(generateMnemonic());
    const recipientDid = publicKeyToDid(recipient.publicKey);
    const { iv, ct } = await encryptForRecipient("secret text", recipientDid);

    // Recipient side: same derivation from their private + our public key
    const session = requireSession();
    const raw = x25519.getSharedSecret(
      ed25519.utils.toMontgomerySecret(recipient.privateKey),
      ed25519.utils.toMontgomery(didToPublicKey(publicKeyToDid(session.publicKey)))
    );
    const secret = sha256.create().update(utf8("awful-dm-v1")).update(raw).digest();

    const aesKey = await crypto.subtle.importKey(
      "raw",
      secret as Uint8Array<ArrayBuffer>,
      "AES-GCM",
      false,
      ["decrypt"]
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unhex(iv) },
      aesKey,
      unhex(ct)
    );
    expect(new TextDecoder().decode(plaintext)).toBe("secret text");
  });
});

describe("did:key codec", () => {
  it("round-trips a public key", () => {
    const { publicKey } = deriveKeypairFromMnemonic(generateMnemonic());
    const did = publicKeyToDid(publicKey);
    expect(did.startsWith("did:key:")).toBe(true);
    expect(hex(didToPublicKey(did))).toBe(hex(publicKey));
  });

  it("throws on invalid did", () => {
    expect(() => didToPublicKey("not-a-did")).toThrow();
  });
});
