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
- **Files** - WebTorrent over the libp2p data channel; <5 MB attachments are
  also persisted in IndexedDB and re-seeded.
- **Identity** - BIP39 mnemonic → ed25519 → did:key, encrypted at rest,
  optional WebAuthn (biometric) unlock, QR device sync.

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
cd frontend && pnpm test    # vitest (crypto, dm codec, storage, wire types)
cd frontend && pnpm check   # svelte-check + tsc
cd relay && go test ./...   # rendezvous registry
```

## Deploy

`docker-compose.dokploy.yml` - relay + sfu + coturn + frontend behind
Traefik. Set `DOMAIN`, `ANNOUNCED_IP` (SFU public IP), `KLIPY_API_KEY`,
`VITE_API_URL`, `VITE_RELAY_MULTIADDR`.

## Docs

`docs/spec.md` - data model, sync protocol, wire formats, crypto details.
