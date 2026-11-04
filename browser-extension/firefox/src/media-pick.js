// Which captured stream a one-click send should use, and the message that
// carries it to the background. The popup's primary button and the on-video
// download button both go through here so the two can never disagree about
// what "the video on this page" is.
import { getHlsGroupKey } from "./hls-grouping.js";
import { isListableMedia } from "./media-list.js";
import { extractSendableHeaders } from "./header-allowlist.js";

export function getFilenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split("/");
    const last = parts[parts.length - 1];
    if (last && last.includes(".")) return decodeURIComponent(last).substring(0, 50);
    return url.substring(0, 60) + "\u2026";
  } catch { return url.substring(0, 60) + "\u2026"; }
}

export function groupHlsManifests(media) {
  const hlsItems = (media || []).filter(m => m.mediaType === "hls");
  const groups = new Map();

  for (const item of hlsItems) {
    const filename = getFilenameFromUrl(item.url).toLowerCase();
    if (filename.includes("subtitle") || filename.includes("caption")) continue;

    const key = getHlsGroupKey(item.url);
    if (!groups.has(key)) groups.set(key, { master: null, variants: [], all: [] });

    const group = groups.get(key);
    group.all.push(item);

    if (filename.includes("master") || filename.includes("playlist") || filename === "index.m3u8") {
      group.master = item;
    } else if (!group.master) {
      group.master = item;
    }
  }

  return groups;
}

export function pickBestMedia(media) {
  if (!media || media.length === 0) return null;

  const hlsGroups = groupHlsManifests(media);
  if (hlsGroups.size > 0) {
    let bestGroup = null;
    let latestTime = 0;

    for (const [, group] of hlsGroups) {
      if (!group.master) continue;
      const maxTime = Math.max(...group.all.map(m => m.detectedAt));
      if (maxTime > latestTime) {
        latestTime = maxTime;
        bestGroup = group;
      }
    }

    if (bestGroup?.master) return bestGroup.master;
  }

  const videoItems = media.filter(m => m.mediaType === "video" && isListableMedia(m));
  if (videoItems.length > 0) {
    return videoItems.reduce((best, m) => m.contentLength > best.contentLength ? m : best, videoItems[0]);
  }

  // A DASH manifest carries no useful size, so it can only be picked by recency
  // — and without this a page whose only media is an mpd renders as "listening"
  // while the item sits in the list underneath.
  const dashItems = media.filter(m => m.mediaType === "dash");
  if (dashItems.length > 0) {
    return dashItems.reduce((best, m) => (m.detectedAt > best.detectedAt ? m : best), dashItems[0]);
  }

  return null;
}

/**
 * Build the `sendToOmniGet` message the background's send path expects.
 * @param {string} url what to enqueue
 * @param {string} platform detected platform, or "generic" for sniffed media
 * @param {object|null|undefined} mediaEntry the sniffer entry, when there is one
 * @param {{title?: string, thumbnail?: string, referer?: string, openApp?: boolean}} context
 */
export function buildSendMessage(url, platform, mediaEntry, context = {}) {
  const msg = { type: "sendToOmniGet", url, platform: platform || "generic" };

  if (context.title) msg.title = context.title;
  if (context.thumbnail) msg.thumbnail = context.thumbnail;
  if (context.referer) msg.referer = context.referer;
  if (mediaEntry?.mediaType) msg.mediaType = mediaEntry.mediaType;
  if (mediaEntry?.contentType) msg.contentType = mediaEntry.contentType;
  // Tells the background to go and fetch the captured playlist text from the
  // page before enqueuing: a blob-backed manifest has no URL the app can use.
  if (mediaEntry?.hasManifest) {
    msg.hasManifest = true;
    msg.tabId = mediaEntry.tabId;
    msg.frameId = mediaEntry.frameId;
  }
  if (typeof context.openApp === "boolean") msg.openApp = context.openApp;

  const headers = extractSendableHeaders(mediaEntry?.requestHeaders);
  if (headers) msg.headers = headers;

  return msg;
}
