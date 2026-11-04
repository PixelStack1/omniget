import test from "node:test";
import assert from "node:assert/strict";
import { buildSendMessage, groupHlsManifests, pickBestMedia } from "../src/media-pick.js";

test("buildSendMessage carries page context and the entry's details", () => {
  const msg = buildSendMessage(
    "https://cdn.example/master.m3u8",
    "generic",
    {
      mediaType: "hls",
      contentType: "application/x-mpegurl",
      hasManifest: true,
      tabId: 7,
      frameId: 2,
      requestHeaders: [
        { name: "Referer", value: "https://page.example/" },
        { name: "Sec-CH-UA", value: "fingerprint" },
      ],
    },
    { title: "A title", thumbnail: "https://page.example/fav.ico", referer: "https://page.example/", openApp: false },
  );
  assert.deepEqual(msg, {
    type: "sendToOmniGet",
    url: "https://cdn.example/master.m3u8",
    platform: "generic",
    title: "A title",
    thumbnail: "https://page.example/fav.ico",
    referer: "https://page.example/",
    mediaType: "hls",
    contentType: "application/x-mpegurl",
    hasManifest: true,
    tabId: 7,
    frameId: 2,
    openApp: false,
    headers: { Referer: "https://page.example/" },
  });
});

test("buildSendMessage leaves out what it does not have", () => {
  assert.deepEqual(buildSendMessage("https://www.youtube.com/watch?v=x", "youtube", null), {
    type: "sendToOmniGet",
    url: "https://www.youtube.com/watch?v=x",
    platform: "youtube",
  });
  assert.equal(buildSendMessage("https://a/b", "", null).platform, "generic");
});

test("pickBestMedia prefers the most recent HLS group's master", () => {
  const media = [
    { url: "https://a/old/master.m3u8", mediaType: "hls", detectedAt: 1, contentLength: 0 },
    { url: "https://b/new/master.m3u8", mediaType: "hls", detectedAt: 9, contentLength: 0 },
    { url: "https://c/big.mp4", mediaType: "video", detectedAt: 10, contentLength: 50_000_000 },
  ];
  assert.equal(pickBestMedia(media).url, "https://b/new/master.m3u8");
});

test("pickBestMedia falls back to the largest listable file, then DASH", () => {
  assert.equal(
    pickBestMedia([
      { url: "https://c/small.mp4", mediaType: "video", detectedAt: 1, contentLength: 1_000_000 },
      { url: "https://c/large.mp4", mediaType: "video", detectedAt: 1, contentLength: 9_000_000 },
    ]).url,
    "https://c/large.mp4",
  );
  assert.equal(
    pickBestMedia([{ url: "https://d/m.mpd", mediaType: "dash", detectedAt: 3, contentLength: 0 }]).url,
    "https://d/m.mpd",
  );
  assert.equal(pickBestMedia([]), null);
  assert.equal(pickBestMedia(null), null);
});

test("groupHlsManifests ignores subtitle playlists", () => {
  const groups = groupHlsManifests([
    { url: "https://a/v/subtitles.m3u8", mediaType: "hls", detectedAt: 1 },
    { url: "https://a/v/master.m3u8", mediaType: "hls", detectedAt: 1 },
  ]);
  const masters = [...groups.values()].map(g => g.master?.url);
  assert.deepEqual(masters, ["https://a/v/master.m3u8"]);
});
