import { makeArchive } from "./archive.ts";
import { ExportIssue, limits, messages, result, validString } from "./contract.ts";

function required<T extends Element>(selector: string, tag: { new(): T }): T {
  const element = document.querySelector(selector);
  if (!(element instanceof tag)) throw new Error("Missing exporter control.");
  return element;
}

const alt = required("#alt", HTMLInputElement);
const capture = required("#capture", HTMLButtonElement);
const save = required("#save", HTMLAnchorElement);
const status = required("#status", HTMLElement);
let lastId = 0;
let pending: { id: number; alt: string } | undefined;
let url: string | undefined;

function clearSave(): void {
  save.hidden = true;
  save.removeAttribute("href");
  if (url !== undefined) URL.revokeObjectURL(url);
  url = undefined;
}

capture.addEventListener("click", (event) => {
  if (!event.isTrusted || pending) return;
  clearSave();
  if (!validString(alt.value, limits.alt) || lastId === 0x7fff_ffff) {
    status.textContent = messages.LIMIT;
    return;
  }
  pending = { id: ++lastId, alt: alt.value.trim() };
  capture.disabled = true;
  status.textContent = "Reading selection…";
  parent.postMessage({ pluginMessage: { kind: "capture", requestId: pending.id, alt: alt.value } }, "*");
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent || !pending || event.data === null || typeof event.data !== "object" ||
      !("pluginMessage" in event.data)) return;
  const value = result(event.data.pluginMessage, pending.id);
  if (value === undefined) return;
  const submitted = pending;
  pending = undefined;
  capture.disabled = false;
  try {
    if (typeof value === "string") throw new ExportIssue(value);
    // Copy into an owned ArrayBuffer for the DOM Blob interface.
    const bytes = new Uint8Array(makeArchive(value, submitted.alt));
    url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    save.href = url;
    save.hidden = false;
    status.textContent = "Capture ready.";
  } catch (error: unknown) {
    clearSave();
    status.textContent = error instanceof ExportIssue ? error.message : messages.CAPTURE;
  }
});

save.addEventListener("click", (event) => {
  if (!event.isTrusted || save.hidden || !url) event.preventDefault();
});
window.addEventListener("pagehide", () => {
  pending = undefined;
  clearSave();
});
