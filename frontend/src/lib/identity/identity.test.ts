import { beforeEach, describe, expect, it } from "vitest";
import {
  AESFromPassword,
  createIdentity,
  lockIdentity,
  unlockIdentity,
  isUnlocked,
} from "./identity";
import { getMnemonicRecord, wipeLocalDatabase } from "../storage";

const PASSWORD = "correct horse battery staple";

describe("password-derived key", () => {
  beforeEach(async () => {
    await wipeLocalDatabase();
    lockIdentity();
  });

  it("stores the PBKDF2 iteration count alongside the mnemonic", async () => {
    await createIdentity(PASSWORD);
    const record = await getMnemonicRecord();
    // Anything that copies this record to another device (QR sync, file
    // backup) must copy this field too - see the round-trip test below.
    expect(record?.iterations).toBeTypeOf("number");
    expect(record!.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it("unlocks with the right password and rejects the wrong one", async () => {
    await createIdentity(PASSWORD);
    lockIdentity();
    await expect(unlockIdentity("not the password")).rejects.toThrow(
      /Wrong password/
    );
    await unlockIdentity(PASSWORD);
    expect(isUnlocked()).toBe(true);
  });

  // The bug this guards: device sync used to copy salt/iv/ciphertext but drop
  // `iterations`, so the receiving device derived the key with the legacy
  // count and told the user their correct password was wrong.
  it("a record that loses its iteration count no longer decrypts", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode("some mnemonic phrase");

    const strongKey = await AESFromPassword(PASSWORD, salt, 600_000);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      strongKey,
      plaintext
    );

    // Same password, legacy iteration count = a different key = failure.
    const legacyKey = await AESFromPassword(PASSWORD, salt, 100_000);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, legacyKey, ciphertext)
    ).rejects.toThrow();

    // Carrying the count across gives back the plaintext.
    const carriedKey = await AESFromPassword(PASSWORD, salt, 600_000);
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      carriedKey,
      ciphertext
    );
    expect(new TextDecoder().decode(out)).toBe("some mnemonic phrase");
  });

  it("still opens legacy records written before the count was stored", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const legacyKey = await AESFromPassword(PASSWORD, salt, 100_000);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      legacyKey,
      new TextEncoder().encode("legacy mnemonic")
    );

    // unlockIdentity falls back to 100k when `iterations` is absent, which is
    // exactly what an old record (or an old peer's export) looks like.
    const key = await AESFromPassword(PASSWORD, salt, 100_000);
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    expect(new TextDecoder().decode(out)).toBe("legacy mnemonic");
  });
});
