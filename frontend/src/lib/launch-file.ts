/**
 * Files handed to the app by the OS (manifest file_handlers): the launch
 * queue fires before any UI that could consume the file exists, so the file
 * parks here and the restore flow picks it up when it mounts.
 */

let _pendingBackup: File | null = null;

export function initLaunchQueue(onBackupFile: () => void): void {
  const lq = (
    window as Window & {
      launchQueue?: {
        setConsumer(cb: (params: { files: FileSystemFileHandle[] }) => void): void;
      };
    }
  ).launchQueue;
  if (!lq) return;
  lq.setConsumer((params) => {
    void (async () => {
      const handle = params.files?.[0];
      if (!handle) return;
      try {
        _pendingBackup = await handle.getFile();
        onBackupFile();
      } catch {
        // Unreadable handle: nothing to restore.
      }
    })();
  });
}

/** The restore flow takes the file exactly once. */
export function takePendingBackupFile(): File | null {
  const f = _pendingBackup;
  _pendingBackup = null;
  return f;
}
