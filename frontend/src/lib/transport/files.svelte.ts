import {
  getAttachmentsByInfoHash,
  getAttachmentsWithData,
  putAttachment,
  updateAttachmentStatus,
} from "$lib/storage";
import {
  _peerIdToDid,
  _transport,
  MAX_PERSISTED_ATTACHMENT_BYTES,
  transportState,
} from "./transport.svelte";
import type {
  Attachment,
  FileEntry,
  FileSignalWireMessage,
} from "$lib/types/message";
import { encode } from "$lib/utils";
import type { FileTransferSnapshot } from "./types";
import type { WebTorrentFileTransport } from "./file/webtorrent";

let _fileTransport: WebTorrentFileTransport | null = null;
let _initialized = false;

function getFileTransport(): WebTorrentFileTransport {
  if (!_fileTransport)
    throw new Error("File transport not initialized. Call initFiles() first.");
  return _fileTransport;
}

async function _persistAttachmentStatusForInfoHash(
  infoHash: string,
  status: Attachment["status"]
): Promise<void> {
  const attachments = await getAttachmentsByInfoHash(infoHash);
  await Promise.all(
    attachments.map((attachment) =>
      updateAttachmentStatus(attachment.id, status)
    )
  );
}

async function _persistDownloadedBlob(
  infoHash: string,
  blob: Blob
): Promise<void> {
  const attachments = await getAttachmentsByInfoHash(infoHash);
  if (!attachments.length) return;

  const shouldPersistData = attachments.some(
    (attachment) => attachment.size <= MAX_PERSISTED_ATTACHMENT_BYTES
  );
  const data = shouldPersistData ? await blob.arrayBuffer() : undefined;

  await Promise.all(
    attachments.map((attachment) =>
      putAttachment({
        ...attachment,
        data:
          attachment.size <= MAX_PERSISTED_ATTACHMENT_BYTES
            ? data
            : attachment.data,
        status: "complete",
      })
    )
  );
}

export function initFiles(fileTransport: WebTorrentFileTransport): void {
  if (_initialized) return;
  _initialized = true;
  _fileTransport = fileTransport;

  _fileTransport.on("signal", (peerId, envelope) => {
    _transport.send(
      peerId,
      encode({
        type: "__file_signal",
        payload: envelope,
      } satisfies FileSignalWireMessage)
    );
  });

  _fileTransport.on("transfer", (snapshot) => {
    withFileTransfer(snapshot);

    if (
      snapshot.status === "seeding" ||
      snapshot.status === "complete" ||
      snapshot.status === "failed"
    ) {
      _persistAttachmentStatusForInfoHash(
        snapshot.infoHash,
        snapshot.status
      ).catch(() => {});
    }
  });

  _fileTransport.on("downloaded", (infoHash, blob) => {
    _persistDownloadedBlob(infoHash, blob).catch(() => {});

    getAttachmentsByInfoHash(infoHash)
      .then(async (attachments) => {
        const existingTransfer = transportState.fileTransfers.get(infoHash);
        if (existingTransfer?.seeding) return;
        const attachment = attachments[0];
        if (!attachment) return;
        const file = new File([blob], attachment.filename, {
          type: attachment.mimeType,
          lastModified: Date.now(),
        });
        await getFileTransport().seedFiles([file]);
        await _persistAttachmentStatusForInfoHash(infoHash, "seeding");
      })
      .catch(() => {});
  });
}

export function isFileSignalWireMessage(
  value: unknown
): value is FileSignalWireMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "__file_signal" &&
    typeof (value as { payload?: unknown }).payload === "object" &&
    (value as { payload?: unknown }).payload !== null
  );
}

export function maybePeerIdFromSenderId(senderId: string): string | null {
  const connectedPeers = _transport.peers();
  if (connectedPeers.includes(senderId)) return senderId;
  for (const [peerId, did] of _peerIdToDid) {
    if (did === senderId && connectedPeers.includes(peerId)) return peerId;
  }
  return null;
}

export function shouldAutoDownload(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType.startsWith("video/");
}

export async function fileFingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer()
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function withFileTransfer(snapshot: FileTransferSnapshot): void {
  const prev = transportState.fileTransfers.get(snapshot.infoHash);

  // Determine which blobURL to use: defensively prefer existing one unless
  // snapshot provides a new one with a status indicating completion
  let blobURLToUse = prev?.blobURL;
  if (snapshot.blobURL) {
    // Only accept snapshot's blobURL if we don't have one yet, or if status
    // indicates a fresh transfer (complete or seeding)
    if (!prev?.blobURL || snapshot.status === "complete" || snapshot.status === "seeding") {
      blobURLToUse = snapshot.blobURL;
    }
  }

  // Revoke previous blobURL if we're replacing it with a different one
  if (prev?.blobURL && blobURLToUse && prev.blobURL !== blobURLToUse) {
    URL.revokeObjectURL(prev.blobURL);
  }

  const nextSnapshot: FileTransferSnapshot = {
    ...(prev ?? {}),
    ...snapshot,
    blobURL: blobURLToUse,
  } as FileTransferSnapshot;
  const next = new Map(transportState.fileTransfers);
  next.set(snapshot.infoHash, nextSnapshot);
  transportState.fileTransfers = next;
}

export async function _hydrateFileTransfersFromStorage(
  roomCode: string
): Promise<void> {
  const seedable = await getAttachmentsWithData(roomCode);
  const dedup = new Map<string, Attachment>();
  for (const attachment of seedable) {
    if (!attachment.data) continue;
    if (!dedup.has(attachment.infoHash))
      dedup.set(attachment.infoHash, attachment);
  }

  for (const attachment of dedup.values()) {
    if (!attachment.data) continue;
    const file: FileEntry = {
      infoHash: attachment.infoHash,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
    const blobURL = URL.createObjectURL(
      new Blob([attachment.data], { type: attachment.mimeType })
    );
    withFileTransfer({
      ...file,
      status: attachment.status,
      progress: 1,
      done: true,
      seeding: attachment.status === "seeding",
      peers: 0,
      seeders: attachment.status === "seeding" ? 1 : 0,
      blobURL,
    });
  }
}

export async function _resumeAttachmentSeeding(
  roomCode: string
): Promise<void> {
  const seedable = await getAttachmentsWithData(roomCode);
  const dedup = new Map<string, Attachment>();
  for (const attachment of seedable) {
    if (!attachment.data) continue;
    if (!dedup.has(attachment.infoHash))
      dedup.set(attachment.infoHash, attachment);
  }

  const files = [...dedup.values()].map(
    (attachment) =>
      new File([attachment.data!], attachment.filename, {
        type: attachment.mimeType,
        lastModified: attachment.createdAt,
      })
  );
  if (!files.length) return;

  const seeded = await getFileTransport().seedFiles(files);
  await Promise.all(
    seeded.map((entry) =>
      _persistAttachmentStatusForInfoHash(entry.infoHash, "seeding")
    )
  );
}
