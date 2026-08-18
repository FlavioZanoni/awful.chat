/**
 * Dragging files over the chat shows the full-cover dropzone overlay, leaving
 * hides it, and dropping stages the file as an attachment ready to send.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("drag and drop stages attachments");
const [alice] = await bootPeers(["Alice"], { ports: [9307] });

const dragEvent = (type) => `(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(64)], 'drag.bin',
    { type: 'application/octet-stream' }));
  const target = document.querySelector('main') ?? document.body;
  target.dispatchEvent(new DragEvent(${JSON.stringify(type)},
    { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
})()`;

try {
  await alice.createRoom("DropZone");

  await alice.eval(dragEvent("dragenter"));
  await alice.waitFor("dropzone overlay shown", () =>
    alice.eval(`/Drop files to attach/.test(document.body.innerText) || null`));
  check.ok(true, "overlay covers the chat while dragging");

  await alice.eval(dragEvent("dragleave"));
  await alice.waitFor("overlay hidden after leave", () =>
    alice.eval(`!/Drop files to attach/.test(document.body.innerText) || null`));
  check.ok(true, "overlay goes away when the drag leaves");

  await alice.eval(dragEvent("drop"));
  await alice.waitFor("file staged", () =>
    alice.eval(`/drag\\.bin/.test(document.body.innerText) || null`));
  check.ok(true, "dropped file is staged as an attachment");
  const overlayGone = await alice.eval(
    `!/Drop files to attach/.test(document.body.innerText)`);
  check.ok(overlayGone === true, "overlay cleared after the drop");

  check.finish();
} finally {
  await closeAll([alice]);
}
