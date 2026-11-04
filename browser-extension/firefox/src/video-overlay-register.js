// Registers the on-video download button content script on exactly the origins
// the extension already holds: the fixed platform list from the manifest, plus
// every site once the user has granted the optional wildcard (the sniffer and
// deep search ask for it). It never asks for a permission of its own, so the
// button adds no install-time warning.
//
// The script stays registered whether or not the button is switched on. The
// content script reads the toggle itself and follows storage changes, which is
// what lets the option take effect on open tabs without a reload.
import { DEEP_SEARCH_EXTRA_BLOCKED_HOSTS } from "./deep-search-toggle.js";

export const VIDEO_OVERLAY_SCRIPT_ID = "omniget-video-overlay";
export const VIDEO_OVERLAY_FILES = Object.freeze([
  "src/video-overlay-core.js",
  "src/video-overlay.js",
]);

const WILDCARD_PATTERNS = new Set(["*://*/*", "<all_urls>", "http://*/*", "https://*/*"]);

// The loopback permissions exist for the desktop bridge, not for pages, so they
// do not on their own make the button appear on localhost.
const LOOPBACK_PATTERNS = new Set(["http://127.0.0.1/*", "http://localhost/*"]);

/**
 * @param {Array<string>|undefined} origins granted host permission patterns
 * @returns {Array<string>} match patterns for the content script
 */
export function overlayMatchesFromOrigins(origins) {
  if (!Array.isArray(origins)) return [];
  const out = [];
  for (const origin of origins) {
    if (typeof origin !== "string" || origin === "") continue;
    if (WILDCARD_PATTERNS.has(origin)) return ["*://*/*"];
    if (LOOPBACK_PATTERNS.has(origin)) continue;
    if (!/^(\*|https?):\/\//.test(origin)) continue;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

// Video calls, mail and office suites: a webcam tile is a <video> too, and a
// download button on someone's face is never what the user wants.
export function overlayExcludeMatches(hosts = DEEP_SEARCH_EXTRA_BLOCKED_HOSTS) {
  const out = [];
  for (const host of hosts) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
    out.push(`*://*.${host}/*`);
  }
  return out;
}

let pending = Promise.resolve(false);

async function syncOnce(api) {
  const scripting = api?.scripting;
  if (!scripting?.registerContentScripts || !scripting?.unregisterContentScripts) return false;

  let origins = [];
  try {
    const all = await api.permissions.getAll();
    origins = all?.origins ?? [];
  } catch {
    origins = [];
  }
  const matches = overlayMatchesFromOrigins(origins);

  try {
    await scripting.unregisterContentScripts({ ids: [VIDEO_OVERLAY_SCRIPT_ID] });
  } catch {
    // Not registered yet; that is the normal first run.
  }
  if (matches.length === 0) return false;

  try {
    await scripting.registerContentScripts([
      {
        id: VIDEO_OVERLAY_SCRIPT_ID,
        js: VIDEO_OVERLAY_FILES.slice(),
        matches,
        excludeMatches: overlayExcludeMatches(),
        runAt: "document_idle",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
    return true;
  } catch (error) {
    console.warn("[OmniGet] video overlay registration failed:", error);
    return false;
  }
}

// Serialized: a permission change can land while the startup sync is still
// unregistering, and two overlapping register calls with the same id throw.
export function syncVideoOverlayRegistration(api = globalThis.chrome) {
  pending = pending.catch(() => false).then(() => syncOnce(api));
  return pending;
}
