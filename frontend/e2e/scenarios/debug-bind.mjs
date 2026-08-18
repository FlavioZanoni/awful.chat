import { bootPeers, closeAll, sleep } from "../driver.mjs";
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });
const st = async (p) => `${p.name} peers=${(await p.state()).peers} bound=${(await p.state()).bound}`;
try {
  const room = await alice.createRoom("Bind");
  await bob.joinRoom(room);
  await sleep(12000);
  console.log("initial:", await st(alice), "|", await st(bob));

  await bob.go("/app");
  await sleep(2000);
  await bob.go("/r/" + room);
  await bob.waitFor("in room", async () => (await bob.eval(`window.__awful?.state.roomCode`)) === room);
  await sleep(15000);
  console.log("after reload:", await st(alice), "|", await st(bob));
  console.log("bob unlocked?", await bob.eval(`(async()=>{const i=await import('/src/lib/identity/identity.svelte.ts');return JSON.stringify({did:!!i.identityStore.did, unlocked:i.identityStore.isUnlocked})})()`));
  console.log("bob sees peers:", await bob.eval(`JSON.stringify(window.__awful.state.peers.map(p=>p.slice(-6)))`));
  console.log("alice map:", await alice.eval(`JSON.stringify([...window.__awful.peerIdToDid].map(([k,v])=>[k.slice(-6),v.slice(-6)]))`));

  console.log("\nbob broadcasts profile manually:", await bob.eval(`(async()=>{
    const t = await import('/src/lib/transport/transport.svelte.ts');
    await t.broadcastProfile();
    return 'sent';
  })()`));
  await sleep(8000);
  console.log("after manual:", await st(alice), "|", await st(bob));
} finally { await closeAll([alice, bob]); }
