import SimplePeer from "simple-peer";
import type { Instance as SimplePeerInstance } from "simple-peer";
import type WebTorrentType from "webtorrent";

type WTClient = InstanceType<typeof WebTorrentType>;
import type {
  FileDescriptor,
  FileSignalEnvelope,
  FileTransferEvents,
  FileTransferSnapshot,
  FileTransferTransport,
} from "../types";
import { getIceServers } from "../ice-server-list";

type TorrentLike = {
  infoHash: string;
  name?: string;
  length?: number;
  progress: number;
  done: boolean;
  numPeers?: number;
  files?: Array<{
    getBlob: (cb: (err: unknown, blob?: Blob) => void) => void;
  }>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  addPeer?: (peer: unknown) => void;
};

function wtKey(infoHash: string, peerId: string): string {
  return `${infoHash}:${peerId}`;
}

function isValidInfoHash(h: string): boolean {
  return /^[a-f0-9]{40}$/i.test(h) || /^[a-z2-7]{32}$/i.test(h);
}

export class WebTorrentFileTransport implements FileTransferTransport {
  /**
   * Created on first use: the library is large and a session that never
   * touches a file should not pay for it at boot, in bundle or in memory.
   */
  private clientP: Promise<WTClient> | null = null;

  private client(): Promise<WTClient> {
    if (!this.clientP) {
      this.clientP = import("webtorrent").then(
        ({ default: WebTorrent }) =>
          new WebTorrent({
            dht: false,
            tracker: false,
            lsd: false,
            utPex: false,
          } as never)
      );
    }
    return this.clientP;
  }

  private handlers = new Map<keyof FileTransferEvents, Set<Function>>();
  private transfers = new Map<string, FileTransferSnapshot>();
  private knownFiles = new Map<string, FileDescriptor>();
  private localSeedHashes = new Set<string>();
  private connectedPeers = new Set<string>();
  private seedersByHash = new Map<string, Set<string>>();
  private wtPeers = new Map<string, SimplePeerInstance>();
  private attachedTorrents = new Set<string>();
  private seedingByHash = new Map<string, boolean>();

  constructor(private readonly selfId: () => string) {}

  async seedFiles(files: File[]): Promise<FileDescriptor[]> {
    const seeded = await Promise.all(
      files.map((file) => this.seedSingle(file))
    );
    for (const desc of seeded) {
      for (const peerId of this.connectedPeers) {
        this.emit("signal", peerId, {
          kind: "file-seeder",
          file: desc,
        });
      }
    }
    return seeded;
  }

  registerSeeder(file: FileDescriptor, seederPeerId: string): void {
    if (!isValidInfoHash(file.infoHash)) {
      console.warn(`Rejecting seeder registration with invalid infoHash: ${file.infoHash}`);
      return;
    }

    this.knownFiles.set(file.infoHash, file);

    if (!this.seedersByHash.has(file.infoHash)) {
      this.seedersByHash.set(file.infoHash, new Set());
    }
    this.seedersByHash.get(file.infoHash)!.add(seederPeerId);

    const existing = this.transfers.get(file.infoHash);
    if (!existing) {
      this.upsertTransfer({
        ...file,
        status: "pending",
        progress: 0,
        done: false,
        seeding: false,
        peers: 0,
        seeders: this.seedersByHash.get(file.infoHash)?.size ?? 0,
      });
    } else {
      this.upsertTransfer({
        ...existing,
        seeders:
          this.seedersByHash.get(file.infoHash)?.size ?? existing.seeders,
      });
    }

    if (existing?.status === "downloading") {
      this.createWTPeer(file.infoHash, seederPeerId, true);
    }
  }

  ensureDownload(file: FileDescriptor): void {
    if (!isValidInfoHash(file.infoHash)) {
      console.warn(`Rejecting download with invalid infoHash: ${file.infoHash}`);
      return;
    }

    this.knownFiles.set(file.infoHash, file);
    const existing = this.transfers.get(file.infoHash);
    if (existing?.status === "complete" || existing?.status === "seeding") {
      return;
    }

    void this.client().then((client) => {
      const torrent = client.get(
        file.infoHash
      ) as unknown as TorrentLike | null;
      if (!torrent) {
        const added = client.add(file.infoHash, {
          announce: [],
        }) as TorrentLike;
        this.attachTorrent(added, false, file);
      } else {
        this.attachTorrent(torrent, false, file);
      }
    });

    this.upsertTransfer({
      ...file,
      status: "downloading",
      progress: existing?.progress ?? 0,
      done: false,
      seeding: false,
      peers: existing?.peers ?? 0,
      seeders:
        this.seedersByHash.get(file.infoHash)?.size ?? existing?.seeders ?? 0,
      blobURL: existing?.blobURL,
    });

    const seeders = this.seedersByHash.get(file.infoHash);
    if (!seeders || seeders.size === 0) return;

    for (const peerId of seeders) {
      if (peerId === this.selfId()) continue;
      this.createWTPeer(file.infoHash, peerId, true);
    }
  }

  handleSignal(fromPeerId: string, envelope: FileSignalEnvelope): void {
    if (envelope.kind === "file-seeder") {
      this.registerSeeder(envelope.file, fromPeerId);
      return;
    }

    if (!isValidInfoHash(envelope.infoHash)) {
      console.warn(`Rejecting signal with invalid infoHash: ${envelope.infoHash}`);
      return;
    }

    const key = wtKey(envelope.infoHash, fromPeerId);
    if (!this.wtPeers.has(key)) {
      this.createWTPeer(envelope.infoHash, fromPeerId, false);
    }
    this.wtPeers.get(key)?.signal(envelope.signal as never);
  }

  onPeerConnect(peerId: string): void {
    this.connectedPeers.add(peerId);
    for (const infoHash of this.localSeedHashes) {
      const file = this.knownFiles.get(infoHash);
      if (!file) continue;
      this.emit("signal", peerId, {
        kind: "file-seeder",
        file,
      });
    }
  }

  onPeerDisconnect(peerId: string): void {
    this.connectedPeers.delete(peerId);

    for (const [infoHash, seeders] of this.seedersByHash) {
      if (seeders.delete(peerId)) {
        const existing = this.transfers.get(infoHash);
        if (existing) {
          this.upsertTransfer({
            ...existing,
            seeders: seeders.size,
          });
        }
      }
      if (seeders.size === 0) {
        // When last seeder disconnects, fail any in-flight downloads
        const transfer = this.transfers.get(infoHash);
        if (transfer && transfer.status === "downloading" && !transfer.done) {
          this.upsertTransfer({
            ...transfer,
            status: "failed",
            error: "Seeder disconnected",
          });
        }
        this.seedersByHash.delete(infoHash);
      }
    }

    for (const key of [...this.wtPeers.keys()]) {
      if (key.endsWith(`:${peerId}`)) {
        this.wtPeers.get(key)?.destroy();
        this.wtPeers.delete(key);
      }
    }
  }

  getTransfer(infoHash: string): FileTransferSnapshot | undefined {
    return this.transfers.get(infoHash);
  }

  getTransfers(): FileTransferSnapshot[] {
    return [...this.transfers.values()];
  }

  on<K extends keyof FileTransferEvents>(
    event: K,
    handler: FileTransferEvents[K]
  ): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<K extends keyof FileTransferEvents>(
    event: K,
    handler: FileTransferEvents[K]
  ): void {
    this.handlers.get(event)?.delete(handler);
  }

  resetTransfers(): void {
    for (const peer of this.wtPeers.values()) {
      peer.destroy();
    }
    this.wtPeers.clear();

    const blobUrls = new Set(
      [...this.transfers.values()]
        .map((t) => t.blobURL)
        .filter(Boolean) as string[]
    );
    for (const url of blobUrls) URL.revokeObjectURL(url);

    this.transfers.clear();
    this.knownFiles.clear();
    this.seedersByHash.clear();
    this.localSeedHashes.clear();
    this.attachedTorrents.clear();
    this.seedingByHash.clear();
  }

  destroy(): void {
    this.resetTransfers();
    this.connectedPeers.clear();
    this.clientP?.then((client) => client.destroy(() => {}));
    this.clientP = null;
  }

  private async seedSingle(file: File): Promise<FileDescriptor> {
    const client = await this.client();
    return new Promise<FileDescriptor>((resolve, reject) => {
      const torrent = client.seed(
        file,
        { announce: [] },
        (created: any) => {
          const descriptor: FileDescriptor = {
            infoHash: created.infoHash,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
          };

          this.knownFiles.set(descriptor.infoHash, descriptor);
          this.localSeedHashes.add(descriptor.infoHash);
          this.registerSeeder(descriptor, this.selfId());
          this.attachTorrent(created, true, descriptor);

          this.upsertTransfer({
            ...descriptor,
            status: "seeding",
            progress: 1,
            done: true,
            seeding: true,
            peers: created.numPeers ?? 0,
            seeders: this.seedersByHash.get(descriptor.infoHash)?.size ?? 1,
          });

          resolve(descriptor);
        }
      ) as unknown as TorrentLike;

      (torrent as unknown as { on: Function }).on("error", (err: Error) => {
        const message = err?.message ?? "";
        if (message.includes("Cannot add duplicate torrent")) {
          const existing = client.get(
            (torrent as any).infoHash
          ) as unknown as TorrentLike | null;
          if (existing?.infoHash) {
            const descriptor: FileDescriptor = {
              infoHash: existing.infoHash,
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
              size: file.size,
            };
            this.knownFiles.set(descriptor.infoHash, descriptor);
            this.localSeedHashes.add(descriptor.infoHash);
            this.registerSeeder(descriptor, this.selfId());
            this.attachTorrent(existing, true, descriptor);
            this.upsertTransfer({
              ...descriptor,
              status: "seeding",
              progress: 1,
              done: true,
              seeding: true,
              peers: existing.numPeers ?? 0,
              seeders: this.seedersByHash.get(descriptor.infoHash)?.size ?? 1,
            });
            resolve(descriptor);
            return;
          }
        }
        reject(err);
      });
    });
  }

  private createWTPeer(
    infoHash: string,
    peerId: string,
    initiator: boolean
  ): void {
    const key = wtKey(infoHash, peerId);
    if (this.wtPeers.has(key)) return;

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      channelName: `wt:${infoHash}`,
      streams: [],
      config: {
        iceCandidatePoolSize: 10,
        iceServers: getIceServers(),
      },
    });

    this.wtPeers.set(key, peer);

    peer.on("signal", (signal: unknown) => {
      this.emit("signal", peerId, {
        kind: "file-wt-signal",
        infoHash,
        signal,
      });
    });

    peer.on("connect", () => {
      void this.client().then((client) => {
        const torrent = client.get(
          infoHash
        ) as unknown as TorrentLike | null;
        if (torrent?.addPeer) {
          torrent.addPeer(peer);
        }
      });
    });

    peer.on("error", () => {
      this.wtPeers.delete(key);
    });

    peer.on("close", () => {
      this.wtPeers.delete(key);
    });
  }

  private attachTorrent(
    torrent: TorrentLike,
    seeding: boolean,
    fallback: FileDescriptor
  ): void {
    const infoHash = torrent.infoHash;
    if (!infoHash) return;

    // Always update seeding state - seed wins over download
    if (seeding) {
      this.seedingByHash.set(infoHash, true);
    } else if (!this.seedingByHash.has(infoHash)) {
      this.seedingByHash.set(infoHash, false);
    }

    const descriptor = this.knownFiles.get(infoHash) ?? fallback;

    const pushUpdate = () => {
      const isSeeding = this.seedingByHash.get(infoHash) ?? seeding;
      const existing = this.transfers.get(infoHash);
      this.upsertTransfer({
        infoHash,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        size: descriptor.size,
        status: torrent.done
          ? isSeeding
            ? "seeding"
            : "complete"
          : "downloading",
        progress: torrent.progress ?? existing?.progress ?? 0,
        done: torrent.done,
        seeding: isSeeding,
        peers: torrent.numPeers ?? existing?.peers ?? 0,
        seeders:
          this.seedersByHash.get(infoHash)?.size ?? existing?.seeders ?? 0,
        blobURL: existing?.blobURL,
        error: existing?.error,
      });
    };

    if (this.attachedTorrents.has(infoHash)) {
      pushUpdate();
      return;
    }

    this.attachedTorrents.add(infoHash);
    torrent.on("download", pushUpdate);
    torrent.on("upload", pushUpdate);
    torrent.on("wire", pushUpdate);

    torrent.on("done", () => {
      pushUpdate();
      if (this.seedingByHash.get(infoHash)) return;
      const file = torrent.files?.[0];
      if (!file) return;
      file.getBlob((_err, blob) => {
        if (!blob) return;
        const prev = this.transfers.get(infoHash);
        if (prev?.blobURL) URL.revokeObjectURL(prev.blobURL);
        const blobURL = URL.createObjectURL(blob);
        this.upsertTransfer({
          ...prev,
          infoHash,
          filename: descriptor.filename,
          mimeType: descriptor.mimeType,
          size: descriptor.size,
          status: "complete",
          progress: 1,
          done: true,
          seeding: false,
          peers: torrent.numPeers ?? prev?.peers ?? 0,
          seeders: this.seedersByHash.get(infoHash)?.size ?? prev?.seeders ?? 0,
          blobURL,
        });
        this.emit("downloaded", infoHash, blob);
      });
    });

    torrent.on("error", (...args: unknown[]) => {
      const err = args[0] as Error;
      const prev = this.transfers.get(infoHash);
      // If currently seeding, keep it as seeding and just log the error
      if (prev?.seeding || prev?.status === "seeding") {
        console.error(`Transient error on seeded torrent ${infoHash}:`, err.message);
        return;
      }
      this.upsertTransfer({
        ...(prev ?? descriptor),
        infoHash,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        size: descriptor.size,
        status: "failed",
        progress: prev?.progress ?? 0,
        done: false,
        seeding: this.seedingByHash.get(infoHash) ?? false,
        peers: prev?.peers ?? 0,
        seeders: this.seedersByHash.get(infoHash)?.size ?? prev?.seeders ?? 0,
        blobURL: prev?.blobURL,
        error: err.message,
      });
    });

    pushUpdate();
  }

  private upsertTransfer(snapshot: FileTransferSnapshot): void {
    const existing = this.transfers.get(snapshot.infoHash);
    const next = {
      ...existing,
      ...snapshot,
    } as FileTransferSnapshot;
    this.transfers.set(snapshot.infoHash, next);
    this.emit("transfer", next);
  }

  private emit<K extends keyof FileTransferEvents>(
    event: K,
    ...args: Parameters<FileTransferEvents[K]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as Function)(...args));
  }
}
