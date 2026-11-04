import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The core is a classic content script that publishes one global; importing it
// for its side effect is exactly how the options page consumes it too.
await import("../src/video-overlay-core.js");
const core = globalThis.OmniGetVideoOverlay;

const big = {
  width: 640,
  height: 360,
  connected: true,
  display: "block",
  visibility: "visible",
  opacity: 1,
  hasMediaStream: false,
};

test("exposes a frozen API under one global", () => {
  assert.ok(core, "OmniGetVideoOverlay global missing");
  assert.ok(Object.isFrozen(core));
  assert.equal(core.STORAGE_KEY, "omniget_video_overlay_enabled");
});

test("the toggle is enabled by default and only an explicit false turns it off", () => {
  assert.equal(core.DEFAULT_ENABLED, true);
  assert.equal(core.isOverlayEnabled(undefined), true);
  assert.equal(core.isOverlayEnabled(null), true);
  assert.equal(core.isOverlayEnabled(true), true);
  assert.equal(core.isOverlayEnabled(false), false);
  // Anything that is not the boolean false keeps the default rather than
  // silently hiding the button.
  assert.equal(core.isOverlayEnabled("false"), true);
  assert.equal(core.isOverlayEnabled(0), true);
});

test("a regular player-sized video is eligible", () => {
  assert.equal(core.isEligibleVideo(big), true);
});

test("videos under 200px wide are skipped", () => {
  assert.equal(core.MIN_VIDEO_WIDTH, 200);
  assert.equal(core.isEligibleVideo({ ...big, width: 199 }), false);
  assert.equal(core.isEligibleVideo({ ...big, width: 200 }), true);
});

test("very short videos are skipped", () => {
  assert.equal(core.isEligibleVideo({ ...big, height: core.MIN_VIDEO_HEIGHT - 1 }), false);
  assert.equal(core.isEligibleVideo({ ...big, height: core.MIN_VIDEO_HEIGHT }), true);
});

test("the size thresholds can be overridden", () => {
  assert.equal(core.isEligibleVideo({ ...big, width: 150 }, { minWidth: 100 }), true);
  assert.equal(core.isEligibleVideo(big, { minWidth: 1000 }), false);
});

test("hidden, invisible, detached and camera videos are skipped", () => {
  assert.equal(core.isEligibleVideo({ ...big, display: "none" }), false);
  assert.equal(core.isEligibleVideo({ ...big, visibility: "hidden" }), false);
  assert.equal(core.isEligibleVideo({ ...big, visibility: "collapse" }), false);
  assert.equal(core.isEligibleVideo({ ...big, opacity: 0 }), false);
  assert.equal(core.isEligibleVideo({ ...big, connected: false }), false);
  assert.equal(core.isEligibleVideo({ ...big, hasMediaStream: true }), false);
  assert.equal(core.isEligibleVideo({ ...big, opacity: 0.5 }), true);
});

test("junk input is never eligible", () => {
  assert.equal(core.isEligibleVideo(null), false);
  assert.equal(core.isEligibleVideo(undefined), false);
  assert.equal(core.isEligibleVideo({}), false);
  assert.equal(core.isEligibleVideo({ width: "wide", height: 300 }), false);
  assert.equal(core.isEligibleVideo({ width: NaN, height: 300 }), false);
});

test("only http(s) frames run the overlay", () => {
  assert.equal(core.isSupportedFrameUrl("https://example.com/watch"), true);
  assert.equal(core.isSupportedFrameUrl("http://example.com/"), true);
  assert.equal(core.isSupportedFrameUrl("about:blank"), false);
  assert.equal(core.isSupportedFrameUrl("about:srcdoc"), false);
  assert.equal(core.isSupportedFrameUrl("data:text/html,<video>"), false);
  assert.equal(core.isSupportedFrameUrl("chrome-extension://abc/pages/options.html"), false);
  assert.equal(core.isSupportedFrameUrl(undefined), false);
});

const viewport = { width: 1280, height: 800 };

test("the button sits in the top-right corner of a fully visible video", () => {
  const rect = { left: 100, top: 50, right: 740, bottom: 410, width: 640, height: 360 };
  const pos = core.computeButtonPosition(rect, viewport);
  assert.deepEqual(pos, {
    anchorX: 740 - core.BUTTON_MARGIN,
    top: 50 + core.BUTTON_MARGIN,
    maxWidth: 640 - core.BUTTON_MARGIN * 2,
    maxTop: 410 - core.BUTTON_MARGIN - core.BUTTON_SIZE,
  });
});

test("the button follows the visible part of a video scrolled partly off screen", () => {
  // Top 200px of the player have scrolled above the viewport.
  const rect = { left: 100, top: -200, right: 740, bottom: 160 };
  const pos = core.computeButtonPosition(rect, viewport);
  assert.equal(pos.top, core.BUTTON_MARGIN);
  assert.equal(pos.anchorX, 740 - core.BUTTON_MARGIN);
});

test("the button stays inside the viewport for a video wider than the window", () => {
  const rect = { left: -50, top: 0, right: 2000, bottom: 700 };
  const pos = core.computeButtonPosition(rect, viewport);
  assert.equal(pos.anchorX, viewport.width - core.BUTTON_MARGIN);
  assert.equal(pos.maxWidth, viewport.width - core.BUTTON_MARGIN * 2);
});

test("fullscreen: a video filling the viewport puts the button in the screen corner", () => {
  const rect = { left: 0, top: 0, right: 1280, bottom: 800 };
  const pos = core.computeButtonPosition(rect, viewport);
  assert.equal(pos.anchorX, 1280 - core.BUTTON_MARGIN);
  assert.equal(pos.top, core.BUTTON_MARGIN);
});

test("no position when the video is off screen or its visible sliver is too small", () => {
  assert.equal(core.computeButtonPosition({ left: 0, top: 900, right: 640, bottom: 1260 }, viewport), null);
  assert.equal(core.computeButtonPosition({ left: 0, top: -400, right: 640, bottom: 20 }, viewport), null);
  assert.equal(core.computeButtonPosition(null, viewport), null);
  assert.equal(core.computeButtonPosition({ left: 0, top: 0, right: 10, bottom: 10 }, null), null);
});

test("positions accept DOMRect-like objects with only left/top/width/height", () => {
  const pos = core.computeButtonPosition({ left: 20, top: 30, width: 400, height: 225 }, viewport);
  assert.equal(pos.anchorX, 420 - core.BUTTON_MARGIN);
  assert.equal(pos.top, 30 + core.BUTTON_MARGIN);
});

test("positions are rounded to whole pixels", () => {
  const pos = core.computeButtonPosition({ left: 10.4, top: 20.6, right: 500.7, bottom: 300.2 }, viewport);
  assert.ok(Number.isInteger(pos.anchorX));
  assert.ok(Number.isInteger(pos.top));
  assert.ok(Number.isInteger(pos.maxWidth));
});

test("hover picks the smallest eligible video under the pointer", () => {
  const hero = { item: "hero", rect: { left: 0, top: 0, right: 1200, bottom: 700 }, eligible: true };
  const inner = { item: "inner", rect: { left: 100, top: 100, right: 500, bottom: 400 }, eligible: true };
  const tiny = { item: "tiny", rect: { left: 120, top: 120, right: 200, bottom: 180 }, eligible: false };
  assert.equal(core.pickHoveredVideo([hero, inner, tiny], 150, 150), "inner");
  assert.equal(core.pickHoveredVideo([hero, inner, tiny], 800, 600), "hero");
  assert.equal(core.pickHoveredVideo([hero, inner], 1300, 100), null);
  assert.equal(core.pickHoveredVideo([], 10, 10), null);
  assert.equal(core.pickHoveredVideo(undefined, 10, 10), null);
});

test("the direct source is the first http(s) URL, never a blob", () => {
  assert.equal(core.pickDirectSource("blob:https://x/1", "", ["https://cdn/a.mp4"]), "https://cdn/a.mp4");
  assert.equal(core.pickDirectSource("https://cdn/current.webm", "https://cdn/src.mp4", []), "https://cdn/current.webm");
  assert.equal(core.pickDirectSource("", "", []), "");
  assert.equal(core.pickDirectSource("blob:https://x/1", "", undefined), "");
  assert.equal(core.pickDirectSource("data:video/mp4;base64,AAAA", null, [null]), "");
});

test("intersectRect and containsPoint behave at the edges", () => {
  const a = { left: 0, top: 0, right: 100, bottom: 100 };
  assert.equal(core.intersectRect(a, { left: 100, top: 0, right: 200, bottom: 100 }), null);
  assert.deepEqual(core.intersectRect(a, { left: 50, top: 50, right: 150, bottom: 150 }), {
    left: 50, top: 50, right: 100, bottom: 100, width: 50, height: 50,
  });
  assert.equal(core.containsPoint(a, 100, 100), true);
  assert.equal(core.containsPoint(a, 101, 50), false);
  assert.equal(core.containsPoint(null, 0, 0), false);
});

test("the content script loads after the core and reads the same key", async () => {
  const { VIDEO_OVERLAY_FILES } = await import("../src/video-overlay-register.js");
  assert.deepEqual([...VIDEO_OVERLAY_FILES], ["src/video-overlay-core.js", "src/video-overlay.js"]);
  const script = await readFile(new URL("../src/video-overlay.js", import.meta.url), "utf8");
  assert.match(script, /core\.STORAGE_KEY/);
  assert.match(script, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(script, /MutationObserver/);
});

test("the options page loads the core before its module script", async () => {
  const html = await readFile(new URL("../pages/options.html", import.meta.url), "utf8");
  const core = html.indexOf('src="../src/video-overlay-core.js"');
  const options = html.indexOf('src="options.js"');
  assert.ok(core > 0, "options.html must load video-overlay-core.js");
  assert.ok(core < options, "the core must load before options.js");
  assert.match(html, /id="video-overlay" type="checkbox" checked/);
});

test("computeButtonPosition exposes the lowest top that keeps the button visible", () => {
  const pos = core.computeButtonPosition({ left: 0, top: -100, right: 640, bottom: 260 }, { width: 1280, height: 800 });
  assert.equal(pos.top, 10);
  // visible bottom 260 - margin 10 - size 30
  assert.equal(pos.maxTop, 220);
});

test("findClearTop keeps the default corner when nothing covers it", () => {
  const probed = [];
  const top = core.findClearTop(10, 220, 8, (y) => {
    probed.push(y);
    return true;
  });
  assert.equal(top, 10);
  assert.deepEqual(probed, [10]);
});

test("findClearTop slides below a sticky header", () => {
  // A 46px header covers everything above y = 46.
  assert.equal(core.findClearTop(10, 220, 8, (y) => y >= 46), 50);
});

test("findClearTop tries the last possible spot and gives up when all is covered", () => {
  assert.equal(core.findClearTop(10, 21, 8, (y) => y === 21), 21);
  assert.equal(core.findClearTop(10, 220, 8, () => false), null);
  assert.equal(core.findClearTop(10, 220, 8, null), null);
  assert.equal(core.findClearTop(NaN, 220, 8, () => true), null);
});
