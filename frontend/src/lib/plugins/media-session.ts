/**
 * Host-owned Media Session bridge. navigator.mediaSession is a GLOBAL
 * resource - two plugins writing it directly would fight over the lock
 * screen - so plugins go through host.setNowPlaying and the host
 * arbitrates: the most recent claimer owns the slot, releasing only
 * clears it if you still own it (the tile-presence rule, generalized).
 */

export interface NowPlayingInfo {
  title: string;
  artist?: string;
  artworkUrl?: string;
  playing: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
}

let _owner: symbol | null = null;

function apply(info: NowPlayingInfo | null): void {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    if (!info) {
      ms.metadata = null;
      ms.playbackState = "none";
      for (const a of ["play", "pause", "nexttrack", "previoustrack"] as const) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          /* unsupported action */
        }
      }
      return;
    }
    ms.metadata = new MediaMetadata({
      title: info.title,
      artist: info.artist ?? "",
      artwork: info.artworkUrl
        ? [{ src: info.artworkUrl, sizes: "480x360", type: "image/jpeg" }]
        : [],
    });
    ms.playbackState = info.playing ? "playing" : "paused";
    const bind = (
      action: MediaSessionAction,
      fn: (() => void) | undefined
    ) => {
      try {
        ms.setActionHandler(action, fn ? () => fn() : null);
      } catch {
        /* unsupported action */
      }
    };
    bind("play", info.onPlay);
    bind("pause", info.onPause);
    bind("nexttrack", info.onNext);
    bind("previoustrack", info.onPrevious);
  } catch {
    // Media Session is progressive enhancement, never load-bearing.
  }
}

export function setNowPlayingFor(
  token: symbol,
  info: NowPlayingInfo | null
): void {
  if (info === null) {
    if (_owner === token) {
      _owner = null;
      apply(null);
    }
    return;
  }
  _owner = token;
  apply(info);
}
