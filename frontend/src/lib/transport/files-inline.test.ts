import { beforeEach, describe, expect, it, vi } from "vitest";

const putRecords: Array<Record<string, unknown>> = [];
let byInfoHash: Array<{ data?: ArrayBuffer }> = [];
let seedResult: { infoHash: string } | null = null;
const seeded: File[] = [];

vi.mock("$lib/storage", () => ({
  attachmentEpoch: () => 1,
  getSeedableFiles: async () => [],
  getRoomParticipants: async () => [],
  getAttachmentsByInfoHash: async () => byInfoHash,
  getAttachmentsByMessage: async () => [],
  getAttachmentsWithData: async () => [],
  putAttachment: async (a: Record<string, unknown>) => {
    putRecords.push(a);
  },
  updateAttachmentStatus: async () => {},
  updateAttachmentData: async () => {},
}));

vi.mock("./transport.svelte", () => ({
  _peerIdToDid: new Map(),
  MAX_PERSISTED_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  transportState: { fileTransfers: new Map() },
  _transport: { send: () => {} },
}));

const { initFiles, stripAndAdoptInlineFiles } = await import("./files.svelte");

initFiles({
  on: () => {},
  setLocalFileLookup: () => {},
  seedFiles: async (files: File[]) => {
    seeded.push(...files);
    return [seedResult];
  },
} as never);

// URL.createObjectURL does not exist in the node test env
globalThis.URL.createObjectURL = () => "blob:test";

const HASH = "b".repeat(40);
const b64 = btoa("hello"); // 5 bytes

function fileMsg() {
  return {
    id: "m1",
    roomCode: "room-a",
    meta: {
      files: [
        {
          infoHash: HASH,
          filename: "x.gif",
          mimeType: "image/gif",
          size: 5,
          inline: b64,
        },
      ],
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 2100));

describe("stripAndAdoptInlineFiles", () => {
  beforeEach(() => {
    putRecords.length = 0;
    seeded.length = 0;
    byInfoHash = [];
  });

  it("always strips inline, and stores bytes whose hash matches the signed one", async () => {
    seedResult = { infoHash: HASH };
    const msg = fileMsg();
    stripAndAdoptInlineFiles(msg);
    expect(msg.meta.files[0]).not.toHaveProperty("inline");
    await settle();
    expect(seeded).toHaveLength(1);
    expect(putRecords).toHaveLength(1);
    expect(putRecords[0].infoHash).toBe(HASH);
  }, 10_000);

  it("rejects bytes whose recomputed infoHash differs from the signed one", async () => {
    seedResult = { infoHash: "c".repeat(40) }; // forged bytes hash elsewhere
    const msg = fileMsg();
    stripAndAdoptInlineFiles(msg);
    expect(msg.meta.files[0]).not.toHaveProperty("inline");
    await settle();
    expect(putRecords).toHaveLength(0);
  }, 10_000);

  it("skips adoption when the bytes are already stored", async () => {
    byInfoHash = [{ data: new ArrayBuffer(5) }];
    seedResult = { infoHash: HASH };
    stripAndAdoptInlineFiles(fileMsg());
    await settle();
    expect(seeded).toHaveLength(0);
  }, 10_000);
});
