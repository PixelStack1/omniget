import test from "node:test";
import assert from "node:assert/strict";
import { isDirectMediaUrl, resolveOverlayCapture } from "../src/overlay-capture.js";

const hls = (url, detectedAt, extra = {}) => ({ url, mediaType: "hls", contentLength: 0, detectedAt, ...extra });
const mp4 = (url, contentLength, detectedAt = 1) => ({ url, mediaType: "video", contentLength, detectedAt });

test("a supported platform page sends the page URL, like Alt+O", () => {
  const plan = resolveOverlayCapture({
    pageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    frameUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    videoSrc: "",
    media: [hls("https://cdn.example/master.m3u8", 5)],
  });
  assert.equal(plan.source, "page");
  assert.equal(plan.platform, "youtube");
  assert.equal(plan.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(plan.entry, null);
});

test("an embedded supported player sends the frame URL", () => {
  const plan = resolveOverlayCapture({
    pageUrl: "https://blog.example/post",
    frameUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    media: [],
  });
  assert.equal(plan.source, "frame");
  assert.equal(plan.platform, "youtube");
  assert.equal(plan.url, "https://www.youtube.com/embed/dQw4w9WgXcQ");
});

test("on other pages the sniffer's best capture wins, as in the popup", () => {
  const master = hls("https://cdn.example/v/master.m3u8", 10);
  const plan = resolveOverlayCapture({
    pageUrl: "https://news.example/article",
    frameUrl: "https://news.example/article",
    videoSrc: "",
    media: [mp4("https://cdn.example/ad.mp4", 2_000_000, 1), master],
  });
  assert.equal(plan.source, "sniffed");
  assert.equal(plan.platform, "generic");
  assert.equal(plan.entry, master);
});

test("a capture matching the element's own source is preferred over the page's best", () => {
  const big = mp4("https://cdn.example/big.mp4", 90_000_000);
  const clicked = mp4("https://cdn.example/clicked.mp4", 1_000_000);
  const plan = resolveOverlayCapture({
    pageUrl: "https://news.example/",
    videoSrc: "https://cdn.example/clicked.mp4",
    media: [big, clicked],
  });
  assert.equal(plan.entry, clicked);
});

test("a plain http(s) source nothing captured is sent directly", () => {
  const plan = resolveOverlayCapture({
    pageUrl: "https://commons.wikimedia.org/wiki/File:Example.webm",
    videoSrc: "https://upload.wikimedia.org/x/Example.webm",
    media: [],
  });
  assert.equal(plan.source, "element");
  assert.equal(plan.url, "https://upload.wikimedia.org/x/Example.webm");
  assert.equal(plan.entry.mediaType, "video");
});

test("nothing to send when there is no capture and the element is blob-backed", () => {
  assert.equal(
    resolveOverlayCapture({ pageUrl: "https://shop.example/", videoSrc: "blob:https://shop.example/1", media: [] }),
    null,
  );
  assert.equal(resolveOverlayCapture({}), null);
  assert.equal(resolveOverlayCapture(), null);
});

test("an unsupported page of a known platform falls through to captures", () => {
  // youtube.com home has a platform but no downloadable content type.
  const master = hls("https://cdn.example/preview/master.m3u8", 3);
  const plan = resolveOverlayCapture({ pageUrl: "https://www.youtube.com/", media: [master] });
  assert.equal(plan.source, "sniffed");
  assert.equal(plan.entry, master);
});

test("isDirectMediaUrl only accepts http(s)", () => {
  assert.equal(isDirectMediaUrl("https://a/b.mp4"), true);
  assert.equal(isDirectMediaUrl("http://a/b.mp4"), true);
  assert.equal(isDirectMediaUrl("blob:https://a/1"), false);
  assert.equal(isDirectMediaUrl("not a url"), false);
  assert.equal(isDirectMediaUrl(""), false);
  assert.equal(isDirectMediaUrl(undefined), false);
});
