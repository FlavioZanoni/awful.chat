<script lang="ts">
  import {
    HardDrive,
    KeyRound,
    Send,
    RefreshCw,
    Hash,
    FileDown,
    Smartphone,
    BellOff,
    Video,
  } from "@lucide/svelte";

  // Single source of truth for the "how this app behaves" copy. Rendered both
  // in the first-run dialog (IdentitySetup) and the Quirks settings tab.
  const quirks = [
    {
      icon: HardDrive,
      title: "Every device is a server, yours included",
      body: "Messages, files and your identity live in this browser's storage, never on a server. Clearing site data, private browsing or uninstalling the app erases your copy. That is not always fatal: everyone in a room keeps their own copy, so with your 12 words you can restore your identity, rejoin with the room code and pull history back from peers who are online and still have it. Expect gaps in what comes back, and if everyone in a room wipes their data the conversation is gone for good.",
    },
    {
      icon: KeyRound,
      title: "12 words are your account",
      body: "No email, no phone number, no password reset. Your recovery phrase is shown once during setup: store it somewhere outside this device. Lose both the phrase and the device and the account is gone for good. Your password only decrypts that phrase locally, and biometric unlock stays tied to the device you enabled it on.",
    },
    {
      icon: Send,
      title: "DMs are delivered device to device",
      body: "A direct message needs both people connected. If the other person is offline it stays queued as \"sending\" and goes out by itself the next time you are both online with the app open. Delivery and read receipts exist in DMs only, not in group rooms.",
    },
    {
      icon: RefreshCw,
      title: "Group history comes from whoever is online",
      body: "There is no archive in the cloud. When you join a room or come back to it, you receive the messages held by the peers online at that moment. Anything they do not have arrives later, when someone who kept it shows up.",
    },
    {
      icon: Hash,
      title: "The room code is the invite and the lock",
      body: "Anyone holding a room code can join it. There are no roles, bans or moderation tools yet, so share codes only with people you want in the room.",
    },
    {
      icon: FileDown,
      title: "Files come from other people, not a CDN",
      body: "Attachments move over WebTorrent, directly between people, so a download only progresses while somebody who has that file is online. Downloading also makes you a source: you share it onward, so the more people who keep a copy the faster and more available it gets. Files under 5 MB are stored on this device and shared again automatically after a restart; larger ones are only shared while the app stays open. When the last copy is gone, the file is gone.",
    },
    {
      icon: Smartphone,
      title: "Extra devices need an explicit pairing",
      body: "Signing in elsewhere does not pull your history. Pair devices from Settings > Sync with a QR code, which expires after 5 minutes. Pairing copies what exists at that moment, it is not a continuous cloud sync, and it is best to use one device at a time.",
    },
    {
      icon: BellOff,
      title: "Nothing reaches you while the app is closed",
      body: "There are no push notifications, because no server is holding your messages to wake you up. You receive things while the app is open and connected.",
    },
    {
      icon: Video,
      warn: true,
      title: "Voice is peer to peer, video passes through a server",
      body: "Your messages, files and voice audio all travel straight between peers, never through a server. Camera and screen share are the one exception: they are routed by a media server so bigger calls work, which means that server sees those streams. On a self-hosted instance that server belongs to whoever runs it, and they can access what passes through it, so only turn on your camera or share your screen on an instance you trust.",
    },
  ];
</script>

<div class="flex flex-col gap-2">
  {#each quirks as quirk (quirk.title)}
    <div
      class="flex gap-3 p-3 rounded-lg border {quirk.warn
        ? 'bg-amber-500/5 border-amber-500/40'
        : 'bg-muted/30 border-border/50'}"
    >
      <quirk.icon
        class="w-4 h-4 mt-0.5 shrink-0 {quirk.warn
          ? 'text-amber-500'
          : 'text-primary'}"
      />
      <div class="flex flex-col gap-1 min-w-0">
        <p class="text-xs font-mono font-semibold text-foreground">
          {quirk.title}
        </p>
        <p class="text-xs font-mono text-muted-foreground leading-relaxed">
          {quirk.body}
        </p>
      </div>
    </div>
  {/each}
</div>
