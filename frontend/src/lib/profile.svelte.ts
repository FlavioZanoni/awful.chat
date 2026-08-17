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
}

export const profileStore = $state<ProfileStore>({
  nickname: "Anonymous",
  avatarUrl: undefined,
});

let _blobUrl: string | undefined;

export async function loadProfile(): Promise<void> {
  const p = await getOwnProfile();
  if (!p) return;
  // Repair profiles written before the identity was known: the row was keyed
  // by an empty did, which detaches it from the identity it belongs to.
  if (!p.did && identityStore.did) {
    await rekeyOwnProfile(p.did ?? "", identityStore.did);
  }
  profileStore.nickname = p.nickname || "Anonymous";
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

async function ensureProfile(did?: string): Promise<void> {
  const existing = await getOwnProfile();
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
  await ensureProfile();
  await updateOwnProfile({ pfpURL: url, pfpData: undefined });
  broadcastProfile();
}

/**
 * @param did - pass explicitly during signup: the profile row is keyed by did,
 * and identityStore.did is not populated until the session is finalised.
 */
export async function saveName(name: string, did?: string): Promise<void> {
  profileStore.nickname = name;
  await ensureProfile(did);
  await updateOwnProfile({ nickname: name });
  broadcastProfile();
}
