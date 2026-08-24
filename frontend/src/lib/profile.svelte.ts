import { identityStore } from "$lib/identity/identity.svelte";
import {
  getOwnProfile,
  putOwnProfile,
  updateOwnProfile,
  rekeyOwnProfile,
  pfpBlobURL,
} from "$lib/storage";
import { broadcastProfile } from "$lib/transport/transport.svelte";

interface ProfileStore {
  nickname: string;
  avatarUrl: string | undefined;
  /** User-picked nickname color, hex like "#aabbcc". Absent = default. */
  color: string | undefined;
  bannerUrl: string | undefined;
  tagText: string | undefined;
  tagTextColor: string | undefined;
  tagChipColor: string | undefined;
  bio: string | undefined;
  nameEffect: string | undefined;
}

export const profileStore = $state<ProfileStore>({
  nickname: "Anonymous",
  avatarUrl: undefined,
  color: undefined,
  bannerUrl: undefined,
  tagText: undefined,
  tagTextColor: undefined,
  tagChipColor: undefined,
  bio: undefined,
  nameEffect: undefined,
});

let _blobUrl: string | undefined;

export async function loadProfile(): Promise<void> {
  const p = await getOwnProfile(identityStore.did ?? undefined);
  if (!p) return;
  // Repair profiles written before the identity was known: the row was keyed
  // by an empty did, which detaches it from the identity it belongs to.
  if (!p.did && identityStore.did) {
    await rekeyOwnProfile(p.did ?? "", identityStore.did);
  }
  profileStore.nickname = p.nickname || "Anonymous";
  profileStore.color = p.color;
  profileStore.bannerUrl = p.bannerURL;
  profileStore.tagText = p.tagText;
  profileStore.tagTextColor = p.tagTextColor;
  profileStore.tagChipColor = p.tagChipColor;
  profileStore.bio = p.bio;
  profileStore.nameEffect = p.nameEffect;
  if (_blobUrl) {
    URL.revokeObjectURL(_blobUrl);
    _blobUrl = undefined;
  }
  if (p.pfpURL) {
    profileStore.avatarUrl = p.pfpURL;
  } else if (p.pfpData) {
    _blobUrl = pfpBlobURL(p.pfpData);
    profileStore.avatarUrl = _blobUrl;
  } else {
    profileStore.avatarUrl = undefined;
  }
}

// saveName and saveAvatar can run near-simultaneously during first-run setup;
// each is a check-then-create followed by a patch, and interleaving them let
// the later create erase the earlier patch (the signup avatar vanished).
// Serializing the pairs is enough - no storage changes needed.
let _profileChain: Promise<void> = Promise.resolve();
function chained(fn: () => Promise<void>): Promise<void> {
  const next = _profileChain.then(fn, fn);
  _profileChain = next.catch(() => {});
  return next;
}

async function ensureProfile(did?: string): Promise<void> {
  const existing = await getOwnProfile(identityStore.did ?? undefined);
  if (!existing) {
    await putOwnProfile({
      did: did ?? identityStore.did ?? "",
      isMe: true,
      nickname: profileStore.nickname || "Anonymous",
      updatedAt: Date.now(),
    });
  }
}

export async function saveAvatar(url: string | undefined): Promise<void> {
  profileStore.avatarUrl = url;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ pfpURL: url, pfpData: undefined });
  });
  broadcastProfile();
}

/**
 * @param did - pass explicitly during signup: the profile row is keyed by did,
 * and identityStore.did is not populated until the session is finalised.
 */
export async function saveName(name: string, did?: string): Promise<void> {
  profileStore.nickname = name;
  await chained(async () => {
    await ensureProfile(did);
    await updateOwnProfile({ nickname: name });
  });
  broadcastProfile();
}

/**
 * @param color - the picked hex color, or undefined/null to reset to default.
 * Values are sanitized on receipt from the wire; here we trust the picker.
 */
export async function saveColor(color: string | undefined | null): Promise<void> {
  profileStore.color = color ?? undefined;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ color: color ?? undefined });
  });
  broadcastProfile();
}

export async function saveBanner(url: string | undefined): Promise<void> {
  profileStore.bannerUrl = url;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ bannerURL: url, bannerData: undefined });
  });
  broadcastProfile();
}

export async function saveTag(tagText: string | undefined): Promise<void> {
  tagText = tagText?.toUpperCase();
  profileStore.tagText = tagText;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ tagText: tagText ?? undefined });
  });
  broadcastProfile();
}

export async function saveTagColors(
  textColor: string | undefined,
  chipColor: string | undefined
): Promise<void> {
  profileStore.tagTextColor = textColor;
  profileStore.tagChipColor = chipColor;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({
      tagTextColor: textColor ?? undefined,
      tagChipColor: chipColor ?? undefined,
    });
  });
  broadcastProfile();
}

export async function saveBio(bio: string | undefined): Promise<void> {
  profileStore.bio = bio;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ bio: bio ?? undefined });
  });
  broadcastProfile();
}

export async function saveNameEffect(effect: string | undefined): Promise<void> {
  profileStore.nameEffect = effect;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ nameEffect: effect ?? undefined });
  });
  broadcastProfile();
}
