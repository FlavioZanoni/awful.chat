/**
 * Notification intents: what the user did on a notification, written by the
 * SERVICE WORKER (which may have no app window to talk to) and drained by
 * the app after unlock. Raw IndexedDB on purpose - this module is bundled
 * into the service worker, same pattern as share-target.ts.
 */

const DB_NAME = "awful-notify";
const STORE = "intents";

export interface NotifyIntent {
  kind: "open" | "reply";
  roomCode: string;
  dmPeerDid?: string;
  text: string;
  ts: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function storeNotifyIntent(intent: NotifyIntent): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(intent);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Read AND clear every pending intent, oldest first. */
export async function drainNotifyIntents(): Promise<NotifyIntent[]> {
  const db = await openDb();
  const out = await new Promise<NotifyIntent[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getAll = store.getAll();
    getAll.onsuccess = () => {
      store.clear();
      resolve((getAll.result as NotifyIntent[]) ?? []);
    };
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  // Stale intents (an unlock that never came) are dropped, not replayed.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return out.filter((i) => i.ts > cutoff);
}
