<p align="center">
  <img src="frontend/public/pwa-192x192.png" alt="awful.chat" width="120" height="120">
</p>

# awful.chat

Privacy-focused P2P chat with voice, video, and file sharing. No accounts,
no phone numbers - identity is a BIP39 mnemonic on your device, messages go
peer-to-peer over libp2p, files over WebTorrent. Servers only help peers
find each other and route media for group video.

## Architecture

```
frontend/   Svelte 5 + Vite PWA (the app)
relay/      Go libp2p relay: circuit relay v2 + rendezvous + /og + /klipy proxies
sfu/        mediasoup SFU (Node) for group video & screen share
coturn      TURN server for voice fallback (compose only, stock image)
```

- **Text messages** - gossipsub room topics between browsers; the relay
  forwards encrypted traffic but can't read it (noise, e2e between peers).
  History syncs peer-to-peer via lamport watermarks (see `docs/spec.md`).
- **DMs** - direct libp2p streams with tagged envelopes (chat / delivery ack /
  read ack), offline queue in localStorage, retried when the peer comes online.
- **Voice** - P2P WebRTC (never touches the SFU).
- **Video / screen** - mediasoup SFU, opt-in "click to watch" transmissions.
  Unlike everything else here, this media is NOT end to end encrypted: the SFU
  decrypts it to route it, so whoever runs that server can see it. Text, DMs,
  files and voice never touch it.
- **Files** - WebTorrent between browsers over their own WebRTC connections,
  signalled through libp2p. There are no trackers: peers are introduced by the
  people already in the room. <5 MB attachments are also persisted in
  IndexedDB and re-seeded.
- **Identity** - BIP39 mnemonic → ed25519 → did:key, encrypted at rest,
  optional WebAuthn (biometric) unlock, QR device sync. Each device has its
  own libp2p key, separate from the identity key, so several devices can be
  signed into one account at once; a peer proves which did:key is behind its
  peerId by signing it (see `docs/spec.md`).
- **Offline** - installable PWA. The app shell, your history and your queued
  messages are on the device, so it opens and reads with no network; sending
  waits for peers.

## Development

```sh
docker compose -f docker-compose.dev.yml up   # relay + frontend + sfu
# frontend: http://localhost:5173
```

Or run pieces directly:

```sh
cd frontend && pnpm install && pnpm dev
cd relay && go run .
cd sfu && npm install && npm start
```

## Tests & checks

```sh
cd frontend && pnpm test    # vitest (crypto, peer auth, dm codec, storage,
                            # wire types, audio, volume curve)
cd frontend && pnpm check   # svelte-check + tsc
cd relay && go test ./...   # rendezvous registry + TURN credentials
```

## Deploy

`docker-compose.dokploy.yml` - relay + sfu + coturn + frontend behind
Traefik. Set `DOMAIN`, `ANNOUNCED_IP` (SFU public IP), `KLIPY_API_KEY`,
`VITE_API_URL`, `VITE_RELAY_MULTIADDR`.

### TURN credentials (optional hardening)

By default coturn uses a static shared username/password baked into the client
bundle, so anyone can relay through it. To issue short-lived per-session
credentials instead:

1. Pick a strong secret and set `TURN_SECRET` (and optionally `TURN_URLS`, a
   comma-separated TURN URL list) on the relay service.
2. Switch coturn from `--lt-cred-mech --user=awful:awful` to
   `--use-auth-secret --static-auth-secret=<same TURN_SECRET>`.

The relay's `/turn-credentials` endpoint then hands the frontend HMAC
credentials (coturn REST convention) that expire after 12h. With `TURN_SECRET`
unset the endpoint returns 204 and the client keeps using the static fallback,
so this is safe to leave off until both sides are configured.

## Docs

`docs/spec.md` - data model, sync protocol, wire formats, crypto details.
