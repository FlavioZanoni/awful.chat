import * as mediasoup from "mediasoup";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";

// ── Types mirrored from client mediasoup.ts ───────────────────────────────────

interface MSGetCapabilities {
  type: "ms:get-capabilities";
}
interface MSCapabilities {
  type: "ms:capabilities";
  rtpCapabilities: mediasoup.types.RtpCapabilities;
}
interface MSCreateTransport {
  type: "ms:create-transport";
  direction: "send" | "recv";
}

// The options object sent to the browser client (matches mediasoup-client TransportOptions)
interface ClientTransportOptions {
  id: string;
  iceParameters: mediasoup.types.IceParameters;
  iceCandidates: mediasoup.types.IceCandidate[];
  dtlsParameters: mediasoup.types.DtlsParameters;
}

interface MSTransportOptions {
  type: "ms:transport-options";
  direction: "send" | "recv";
  options: ClientTransportOptions;
}
interface MSConnectTransport {
  type: "ms:connect-transport";
  direction: "send" | "recv";
  dtlsParameters: mediasoup.types.DtlsParameters;
}
interface MSProduce {
  type: "ms:produce";
  kind: mediasoup.types.MediaKind;
  rtpParameters: mediasoup.types.RtpParameters;
  source: "camera" | "screen";
}
interface MSProduced {
  type: "ms:produced";
  producerId: string;
}
interface MSConsume {
  type: "ms:consume";
  producerId: string;
  rtpCapabilities: mediasoup.types.RtpCapabilities;
}

// The options object sent to the browser client (matches mediasoup-client ConsumerOptions)
interface ClientConsumerOptions {
  id: string;
  producerId: string;
  kind: mediasoup.types.MediaKind;
  rtpParameters: mediasoup.types.RtpParameters;
}

interface MSConsumerOptions {
  type: "ms:consumer-options";
  options: ClientConsumerOptions;
  peerId: string;
  source: "camera" | "screen";
}
interface MSNewProducer {
  type: "ms:new-producer";
  peerId: string;
  producerId: string;
  source: "camera" | "screen";
}
interface MSProducerClosed {
  type: "ms:producer-closed";
  peerId: string;
  producerId: string;
  source: "camera" | "screen";
}
interface MSProducerConsumed {
  type: "ms:producer-consumed";
  peerId: string;
  producerId: string;
}
interface MSProducerConsumerClosed {
  type: "ms:producer-consumer-closed";
  peerId: string;
  producerId: string;
}
interface MSCloseConsumer {
  type: "ms:close-consumer";
  producerId: string;
}
interface MSCloseProducer {
  type: "ms:close-producer";
  producerId: string;
}
interface MSPeerLeft {
  type: "ms:peer-left";
  peerId: string;
}

// Envelope sent by the client over this WebSocket connection.
// All messages from client arrive as: { type: "join" } or { type: "ms:*", ... }
type ClientJoin = { type: "join"; roomCode: string; peerId: string };
type ClientMsg =
  | ClientJoin
  | MSGetCapabilities
  | MSCreateTransport
  | MSConnectTransport
  | MSProduce
  | MSConsume
  | MSCloseConsumer
  | MSCloseProducer;

// ── Per-peer state ────────────────────────────────────────────────────────────

interface PeerState {
  peerId: string;
  roomCode: string;
  ws: WebSocket;
  sendTransport: mediasoup.types.WebRtcTransport | null;
  recvTransport: mediasoup.types.WebRtcTransport | null;
  // producerId → { producer, source, consumers Set }
  producers: Map<
    string,
    {
      producer: mediasoup.types.Producer;
      source: "camera" | "screen";
      consumers: Set<string>;
    }
  >;
  // consumerId → { consumer, producerId }
  consumers: Map<
    string,
    { consumer: mediasoup.types.Consumer; producerId: string }
  >;
  // Track which producers have been notified as closed to avoid duplicates
  notifiedClosedProducers: Set<string>;
}

// ── Room state ────────────────────────────────────────────────────────────────

// roomCode → Map<peerId, PeerState>
const rooms = new Map<string, Map<string, PeerState>>();

function getOrCreateRoom(roomCode: string): Map<string, PeerState> {
  if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
  return rooms.get(roomCode)!;
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── mediasoup setup ───────────────────────────────────────────────────────────

const ANNOUNCED_IP = process.env.ANNOUNCED_IP ?? "127.0.0.1";
const RTC_MIN_PORT = parseInt(process.env.RTC_MIN_PORT ?? "40000", 10);
const RTC_MAX_PORT = parseInt(process.env.RTC_MAX_PORT ?? "40499", 10);

const mediaCodecs: mediasoup.types.RouterOptions["mediaCodecs"] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
  },
];

let worker: mediasoup.types.Worker;
// One router per room for now - keyed by roomCode.
// Stores promises to avoid TOCTOU race: concurrent callers await the same pending creation.
const routers = new Map<string, Promise<mediasoup.types.Router>>();

async function getOrCreateRouter(
  roomCode: string,
): Promise<mediasoup.types.Router> {
  if (!routers.has(roomCode)) {
    const promise = worker.createRouter({ mediaCodecs }).then((router) => {
      console.log(`[router] created for room ${roomCode}`);
      return router;
    });
    routers.set(roomCode, promise);
  }
  return routers.get(roomCode)!;
}

async function createWebRtcTransport(
  router: mediasoup.types.Router,
): Promise<mediasoup.types.WebRtcTransport> {
  return router.createWebRtcTransport({
    listenInfos: [
      {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedAddress: ANNOUNCED_IP,
        portRange: { min: RTC_MIN_PORT, max: RTC_MAX_PORT },
      },
      {
        protocol: "tcp",
        ip: "0.0.0.0",
        announcedAddress: ANNOUNCED_IP,
        portRange: { min: RTC_MIN_PORT, max: RTC_MAX_PORT },
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
}

// ── Message handlers ──────────────────────────────────────────────────────────

async function handleGetCapabilities(peer: PeerState): Promise<void> {
  const router = await getOrCreateRouter(peer.roomCode);
  send(peer.ws, {
    type: "ms:capabilities",
    rtpCapabilities: router.rtpCapabilities,
  } as MSCapabilities);
}

async function handleCreateTransport(
  peer: PeerState,
  msg: MSCreateTransport,
): Promise<void> {
  const router = await getOrCreateRouter(peer.roomCode);
  const transport = await createWebRtcTransport(router);

  if (msg.direction === "send") {
    peer.sendTransport = transport;
  } else {
    peer.recvTransport = transport;
  }

  const options: ClientTransportOptions = {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };

  send(peer.ws, {
    type: "ms:transport-options",
    direction: msg.direction,
    options,
  } as MSTransportOptions);
}

async function handleConnectTransport(
  peer: PeerState,
  msg: MSConnectTransport,
): Promise<void> {
  const transport =
    msg.direction === "send" ? peer.sendTransport : peer.recvTransport;
  if (!transport) {
    console.warn(
      `[sfu] connect-transport: no ${msg.direction} transport for peer ${peer.peerId}`,
    );
    return;
  }
  await transport.connect({ dtlsParameters: msg.dtlsParameters });
}

async function handleProduce(peer: PeerState, msg: MSProduce): Promise<void> {
  if (!peer.sendTransport) {
    console.warn(`[sfu] produce: no send transport for peer ${peer.peerId}`);
    return;
  }

  const producer = await peer.sendTransport.produce({
    kind: msg.kind,
    rtpParameters: msg.rtpParameters,
    appData: { source: msg.source, peerId: peer.peerId },
  });

  peer.producers.set(producer.id, {
    producer,
    source: msg.source,
    consumers: new Set(),
  });

  send(peer.ws, { type: "ms:produced", producerId: producer.id } as MSProduced);

  // Notify every other peer in the room about the new producer
  const room = rooms.get(peer.roomCode);
  if (room) {
    for (const [otherPeerId, otherPeer] of room) {
      if (otherPeerId !== peer.peerId) {
        send(otherPeer.ws, {
          type: "ms:new-producer",
          peerId: peer.peerId,
          producerId: producer.id,
          source: msg.source,
        } as MSNewProducer);
      }
    }
  }

  function notifyProducerClosed(producerId: string, source: "camera" | "screen") {
    // Avoid duplicate notifications
    if (peer.notifiedClosedProducers.has(producerId)) {
      return;
    }
    peer.notifiedClosedProducers.add(producerId);

    peer.producers.delete(producerId);
    const room = rooms.get(peer.roomCode);
    if (room) {
      for (const [otherPeerId, otherPeer] of room) {
        if (otherPeerId === peer.peerId) continue;
        send(otherPeer.ws, {
          type: "ms:producer-closed",
          peerId: peer.peerId,
          producerId,
          source,
        } as MSProducerClosed);
      }
    }
  }

  producer.on("transportclose", () => {
    notifyProducerClosed(producer.id, producer.appData.source as "camera" | "screen");
  });

  console.log(
    `[sfu] peer ${peer.peerId} produced ${producer.id} (${msg.source})`,
  );
}

async function handleConsume(peer: PeerState, msg: MSConsume): Promise<void> {
  if (!peer.recvTransport) {
    console.warn(`[sfu] consume: no recv transport for peer ${peer.peerId}`);
    return;
  }

  const router = await getOrCreateRouter(peer.roomCode);

  if (
    !router.canConsume({
      producerId: msg.producerId,
      rtpCapabilities: msg.rtpCapabilities,
    })
  ) {
    console.warn(
      `[sfu] cannot consume producer ${msg.producerId} for peer ${peer.peerId}`,
    );
    return;
  }

  const consumer = await peer.recvTransport.consume({
    producerId: msg.producerId,
    rtpCapabilities: msg.rtpCapabilities,
    paused: false,
  });

  peer.consumers.set(consumer.id, { consumer, producerId: msg.producerId });

  // Find which peer owns this producer and what source it is
  let producerPeerId = "";
  let source: "camera" | "screen" = "camera";
  const room = rooms.get(peer.roomCode);
  if (room) {
    for (const [pid, p] of room) {
      const entry = p.producers.get(msg.producerId);
      if (entry) {
        producerPeerId = pid;
        source = entry.source;
        break;
      }
    }
  }

  // If this is a screen share, notify the producer owner that someone started watching
  if (source === "screen" && producerPeerId) {
    const producerOwner = room?.get(producerPeerId);
    if (producerOwner) {
      send(producerOwner.ws, {
        type: "ms:producer-consumed",
        peerId: peer.peerId,
        producerId: msg.producerId,
      } as MSProducerConsumed);
    }
  }

  const options: ClientConsumerOptions = {
    id: consumer.id,
    producerId: consumer.producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };

  send(peer.ws, {
    type: "ms:consumer-options",
    options,
    peerId: producerPeerId,
    source,
  } as MSConsumerOptions);

  consumer.on("transportclose", () => {
    peer.consumers.delete(consumer.id);
  });
  consumer.on("producerclose", () => {
    peer.consumers.delete(consumer.id);
  });

  console.log(
    `[sfu] peer ${peer.peerId} consuming ${msg.producerId} (${source})`,
  );
}

function handleCloseConsumer(peer: PeerState, msg: MSCloseConsumer): void {
  // Find the consumer by producerId (the map is keyed by consumer.id)
  let entry:
    | { consumer: mediasoup.types.Consumer; producerId: string }
    | undefined;
  for (const e of peer.consumers.values()) {
    if (e.producerId === msg.producerId) {
      entry = e;
      break;
    }
  }
  if (entry) {
    // Notify the producer owner that this peer stopped watching
    const room = rooms.get(peer.roomCode);
    if (room) {
      for (const [, p] of room) {
        const prodEntry = p.producers.get(msg.producerId);
        if (prodEntry && prodEntry.source === "screen") {
          prodEntry.consumers.delete(peer.peerId);
          send(p.ws, {
            type: "ms:producer-consumer-closed",
            peerId: peer.peerId,
            producerId: msg.producerId,
          } as MSProducerConsumerClosed);
          break;
        }
      }
    }
    entry.consumer.close();
    // Find and delete by producerId
    for (const [consumerId, e] of peer.consumers) {
      if (e.producerId === msg.producerId) {
        peer.consumers.delete(consumerId);
        break;
      }
    }
  }
}

function handleCloseProducer(peer: PeerState, msg: MSCloseProducer): void {
  const entry = peer.producers.get(msg.producerId);
  if (entry) {
    const source = entry.source;
    entry.producer.close();
    peer.producers.delete(msg.producerId);

    // Notify all other peers that this producer is closed
    const room = rooms.get(peer.roomCode);
    if (room) {
      for (const [otherPeerId, otherPeer] of room) {
        if (otherPeerId === peer.peerId) continue;
        send(otherPeer.ws, {
          type: "ms:producer-closed",
          peerId: peer.peerId,
          producerId: msg.producerId,
          source,
        } as MSProducerClosed);
      }
    }
  }
}

function handlePeerLeft(peer: PeerState): void {
  const room = rooms.get(peer.roomCode);
  if (!room) return;

  // close all producers
  for (const { producer } of peer.producers.values()) {
    producer.close();
  }
  peer.producers.clear();

  // close all consumers
  for (const { consumer } of peer.consumers.values()) {
    consumer.close();
  }
  peer.consumers.clear();

  peer.sendTransport?.close();
  peer.recvTransport?.close();

  room.delete(peer.peerId);
  console.log(
    `[sfu] peer ${peer.peerId} left room ${peer.roomCode} (${room.size} remaining)`,
  );

  // Notify remaining peers
  for (const otherPeer of room.values()) {
    send(otherPeer.ws, {
      type: "ms:peer-left",
      peerId: peer.peerId,
    } as MSPeerLeft);
  }

  // Clean up empty room
  if (room.size === 0) {
    rooms.delete(peer.roomCode);
    const routerPromise = routers.get(peer.roomCode);
    if (routerPromise) {
      routerPromise.then((router) => {
        router.close();
        routers.delete(peer.roomCode);
        console.log(`[sfu] router closed for empty room ${peer.roomCode}`);
      }).catch((err) => {
        console.error(`[sfu] error closing router for room ${peer.roomCode}:`, err);
      });
    }
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.SFU_PORT ?? "3000", 10);

async function main(): Promise<void> {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });

  worker.on("died", (err) => {
    console.error("[sfu] mediasoup worker died:", err);
    process.exit(1);
  });

  console.log(`[sfu] mediasoup worker started (pid ${worker.pid})`);

  const wss = new WebSocketServer({ port: PORT });

  // Heartbeat to detect and terminate dead connections (silent disconnect, network handover, etc.)
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const isAlive = (ws as any).isAlive;
      if (isAlive === false) {
        ws.terminate();
      } else {
        (ws as any).isAlive = false;
        ws.ping();
      }
    });
  }, 30000); // 30 second interval

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    (ws as any).isAlive = true;
    ws.on("pong", () => {
      (ws as any).isAlive = true;
    });
    let peer: PeerState | null = null;

    ws.on("message", async (raw: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        console.warn("[sfu] invalid JSON from client");
        return;
      }

      // First message must be join
      if (!peer) {
        if (msg.type !== "join") {
          console.warn("[sfu] expected join as first message, got:", msg.type);
          ws.close();
          return;
        }
        const joinMsg = msg as ClientJoin;
        peer = {
          peerId: joinMsg.peerId,
          roomCode: joinMsg.roomCode,
          ws,
          sendTransport: null,
          recvTransport: null,
          producers: new Map(),
          consumers: new Map(),
          notifiedClosedProducers: new Set(),
        };
        const room = getOrCreateRoom(joinMsg.roomCode);
        const oldPeer = room.get(peer.peerId);
        if (oldPeer && oldPeer !== peer) {
          // Duplicate peerId: replace the old (usually silently-dead) session.
          // Close its media directly - do NOT call handlePeerLeft(), which
          // would delete the room and close the router this new session needs
          // (and its async ws-close would otherwise evict the new peer).
          console.log(
            `[sfu] duplicate peerId ${peer.peerId} in room ${peer.roomCode}; replacing old session`,
          );
          for (const { producer } of oldPeer.producers.values()) {
            producer.close();
          }
          for (const { consumer } of oldPeer.consumers.values()) {
            consumer.close();
          }
          oldPeer.sendTransport?.close();
          oldPeer.recvTransport?.close();
          oldPeer.ws.terminate();
        }
        room.set(peer.peerId, peer);

        // Send existing producers to the newly joined peer so it can consume them
        for (const [existingPeerId, existingPeer] of room) {
          if (existingPeerId === peer.peerId) continue;
          for (const [producerId, { source }] of existingPeer.producers) {
            send(peer.ws, {
              type: "ms:new-producer",
              peerId: existingPeerId,
              producerId,
              source,
            } as MSNewProducer);
          }
        }

        console.log(`[sfu] peer ${peer.peerId} joined room ${peer.roomCode}`);
        return;
      }

      // Route ms:* messages
      try {
        switch (msg.type) {
          case "ms:get-capabilities":
            await handleGetCapabilities(peer);
            break;
          case "ms:create-transport":
            await handleCreateTransport(peer, msg as MSCreateTransport);
            break;
          case "ms:connect-transport":
            await handleConnectTransport(peer, msg as MSConnectTransport);
            break;
          case "ms:produce":
            await handleProduce(peer, msg as MSProduce);
            break;
          case "ms:consume":
            await handleConsume(peer, msg as MSConsume);
            break;
          case "ms:close-consumer":
            handleCloseConsumer(peer, msg as MSCloseConsumer);
            break;
          case "ms:close-producer":
            handleCloseProducer(peer, msg as MSCloseProducer);
            break;
          default:
            console.warn("[sfu] unknown message type:", (msg as any).type);
        }
      } catch (err) {
        console.error(`[sfu] error handling ${msg.type}:`, err);
      }
    });

    ws.on("close", () => {
      if (peer) {
        // Only clean up if THIS peer is still the room's current session for
        // its peerId. After a duplicate-join replacement the map holds the new
        // peer, so the old ws closing here must not evict it.
        const room = rooms.get(peer.roomCode);
        if (room && room.get(peer.peerId) === peer) {
          handlePeerLeft(peer);
        }
        peer = null;
      }
    });

    ws.on("error", (err: Error) => {
      console.warn("[sfu] ws error:", err.message);
    });
  });

  console.log(`[sfu] WebSocket server listening on ws://0.0.0.0:${PORT}`);
}

main().catch((err) => {
  console.error("[sfu] fatal:", err);
  process.exit(1);
});
