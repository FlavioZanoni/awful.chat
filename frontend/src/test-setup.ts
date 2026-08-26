// In-memory IndexedDB for storage/identity tests
import "fake-indexeddb/auto";
// Storage tests exercise the real at-rest encryption path: every suite gets
// a deterministic key, same as an unlocked session would arm.
import { initStorageCrypto } from "./lib/storage-crypto";
await initStorageCrypto(new Uint8Array(32).fill(7));
