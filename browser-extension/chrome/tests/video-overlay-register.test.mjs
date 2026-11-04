import test from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_OVERLAY_SCRIPT_ID,
  overlayExcludeMatches,
  overlayMatchesFromOrigins,
  syncVideoOverlayRegistration,
} from "../src/video-overlay-register.js";

test("matches follow the granted platform origins, minus the bridge loopback", () => {
  assert.deepEqual(
    overlayMatchesFromOrigins([
      "http://127.0.0.1/*",
      "http://localhost/*",
      "*://*.youtube.com/*",
      "*://*.vimeo.com/*",
      "*://*.youtube.com/*",
    ]),
    ["*://*.youtube.com/*", "*://*.vimeo.com/*"],
  );
});

test("a granted wildcard collapses to every site", () => {
  assert.deepEqual(overlayMatchesFromOrigins(["*://*.youtube.com/*", "*://*/*"]), ["*://*/*"]);
  assert.deepEqual(overlayMatchesFromOrigins(["<all_urls>"]), ["*://*/*"]);
});

test("junk origins are ignored", () => {
  assert.deepEqual(overlayMatchesFromOrigins(undefined), []);
  assert.deepEqual(overlayMatchesFromOrigins(["", null, "file:///*", "chrome://*/*"]), []);
});

test("video-call and office hosts are excluded", () => {
  const excluded = overlayExcludeMatches();
  assert.ok(excluded.includes("*://*.meet.google.com/*"));
  assert.ok(excluded.includes("*://*.zoom.us/*"));
  assert.deepEqual(overlayExcludeMatches(["analytics", "a.example"]), ["*://*.a.example/*"]);
});

function fakeChrome(origins) {
  const calls = [];
  return {
    calls,
    permissions: { getAll: async () => ({ origins }) },
    scripting: {
      unregisterContentScripts: async (arg) => { calls.push(["unregister", arg]); throw new Error("none"); },
      registerContentScripts: async (arg) => { calls.push(["register", arg]); },
    },
  };
}

test("sync registers an all-frames, persistent script on the granted origins", async () => {
  const api = fakeChrome(["*://*.youtube.com/*", "http://127.0.0.1/*"]);
  assert.equal(await syncVideoOverlayRegistration(api), true);
  const register = api.calls.find(([kind]) => kind === "register")[1][0];
  assert.equal(register.id, VIDEO_OVERLAY_SCRIPT_ID);
  assert.deepEqual(register.matches, ["*://*.youtube.com/*"]);
  assert.deepEqual(register.js, ["src/video-overlay-core.js", "src/video-overlay.js"]);
  assert.equal(register.allFrames, true);
  assert.equal(register.persistAcrossSessions, true);
  assert.equal(register.runAt, "document_idle");
});

test("sync only unregisters when nothing usable is granted", async () => {
  const api = fakeChrome(["http://127.0.0.1/*"]);
  assert.equal(await syncVideoOverlayRegistration(api), false);
  assert.deepEqual(api.calls.map(([kind]) => kind), ["unregister"]);
});

test("sync is a no-op without the scripting API", async () => {
  assert.equal(await syncVideoOverlayRegistration({}), false);
  assert.equal(await syncVideoOverlayRegistration(undefined), false);
});
