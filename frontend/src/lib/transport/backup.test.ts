import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  parseBackup,
  pfpFromJson,
  pfpToJson,
  summarizeBackup,
  type BackupFile,
} from "./backup";

function backupJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: 1_700_000_000_000,
    messages: [],
    attachments: [],
    pending: [],
    watermarks: [],
    yjsDocs: [],
    rooms: [],
    profiles: [],
    savedGifs: [],
    ...overrides,
  });
}

describe("parseBackup", () => {
  it("accepts a well-formed backup", () => {
    const data = parseBackup(backupJson({ messages: [{ id: "m1" }] }));
    expect(data.format).toBe(BACKUP_FORMAT);
    expect(data.messages).toHaveLength(1);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseBackup("not json at all")).toThrow(/valid JSON/);
  });

  it("rejects JSON that is not a backup", () => {
    expect(() => parseBackup(JSON.stringify({ hello: "world" }))).toThrow(
      /not an awful\.chat backup/
    );
    expect(() => parseBackup("null")).toThrow(/not an awful\.chat backup/);
    expect(() => parseBackup('"a string"')).toThrow(
      /not an awful\.chat backup/
    );
  });

  it("refuses a backup from a newer app version", () => {
    expect(() => parseBackup(backupJson({ version: BACKUP_VERSION + 1 }))).toThrow(
      /newer version/
    );
    expect(() => parseBackup(backupJson({ version: "1" }))).toThrow(
      /newer version/
    );
  });

  // A truncated or hand-edited file must not blow up the import half way
  // through, so every collection is coerced to an array.
  it("coerces missing or malformed collections to empty arrays", () => {
    const data = parseBackup(
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        messages: "nope",
      })
    );
    expect(data.messages).toEqual([]);
    expect(data.rooms).toEqual([]);
    expect(data.attachments).toEqual([]);
    expect(data.savedGifs).toEqual([]);
    expect(data.exportedAt).toBe(0);
  });
});

describe("summarizeBackup", () => {
  it("reports identity presence and counts", () => {
    const withIdentity = parseBackup(
      backupJson({
        identity: {
          mnemonic: { salt: [], iv: [], encrypted: [] },
          keypair: { did: "did:key:zAbc", publicKey: [] },
        },
        messages: [{ id: "a" }, { id: "b" }],
        rooms: [{ roomCode: "r1" }],
      })
    ) as BackupFile;
    const s = summarizeBackup(withIdentity);
    expect(s.hasIdentity).toBe(true);
    expect(s.did).toBe("did:key:zAbc");
    expect(s.messages).toBe(2);
    expect(s.rooms).toBe(1);

    const without = summarizeBackup(parseBackup(backupJson()));
    expect(without.hasIdentity).toBe(false);
    expect(without.did).toBeNull();
  });
});

describe("avatar binary round-trip", () => {
  it("survives JSON, which a raw ArrayBuffer would not", () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const room = { roomCode: "r1", pfpData: bytes.buffer };

    // Raw JSON drops an ArrayBuffer to {} - this is the bug being guarded.
    expect(JSON.parse(JSON.stringify(room)).pfpData).toEqual({});

    const encoded = pfpToJson(room);
    const decoded = pfpFromJson(JSON.parse(JSON.stringify(encoded)));
    expect(new Uint8Array(decoded.pfpData as ArrayBuffer)).toEqual(bytes);
  });

  it("leaves records without an avatar untouched", () => {
    const room: { roomCode: string; pfpData?: unknown } = { roomCode: "r1" };
    expect(pfpToJson(room)).toEqual(room);
    expect(pfpFromJson(room)).toEqual(room);
  });

  it("drops a lossily-serialized avatar instead of storing garbage", () => {
    const fromOldPeer = { roomCode: "r1", pfpData: {} };
    expect(pfpFromJson(fromOldPeer)).toEqual({ roomCode: "r1" });
  });
});
