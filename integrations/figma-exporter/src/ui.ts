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
let timer: number | undefined;

function finishRequest(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  pending = undefined;
  capture.disabled = false;
}

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
  const id = pending.id;
  timer = window.setTimeout(() => {
    finishRequest();
    clearSave();
    status.textContent = messages.TIMEOUT;
  }, 30_000);
  // The Figma iframe has no fixed host origin across Desktop and web. The marker carries no user text.
  parent.postMessage({ pluginMessage: { kind: "capture", requestId: id, alt: pending.alt ? "present" : "" } }, "*");
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent || !pending || event.data === null || typeof event.data !== "object" ||
      !("pluginMessage" in event.data)) return;
  const value = result(event.data.pluginMessage, pending.id);
  if (value === undefined) return;
  const submitted = pending;
  finishRequest();
  try {
    if (typeof value === "string") throw new ExportIssue(value);
    // Copy into an owned ArrayBuffer for the DOM Blob interface.
    const bytes = new Uint8Array(makeArchive(value, submitted.alt));
    url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    save.href = url;
    save.hidden = false;
    if (value.image && alt.value.trim() === submitted.alt) alt.value = "";
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
  finishRequest();
  clearSave();
});
