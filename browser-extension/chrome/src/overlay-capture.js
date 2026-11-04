// Decides what the on-video download button sends. It deliberately mirrors the
// two existing entry points instead of inventing a third rule:
//   - a supported platform page goes out as the page URL, exactly like Alt+O
//     and the popup's "known platform" button;
//   - anything else uses the sniffer's captures for the page, picked the same
//     way the popup's primary button picks them.
// The clicked element only refines that choice (an embedded player's frame, or
// the capture that matches the element's own source) and is used directly as a
// last resort when it plays a plain http(s) file nothing else captured.
//
// DRM is not special-cased on purpose: protected media is sent the same way
// the popup would send it, and the desktop app explains why it refuses it.
import { detectSupportedMediaUrl } from "./detect.js";
import { pickBestMedia } from "./media-pick.js";

export function isDirectMediaUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {{pageUrl?: string, frameUrl?: string, videoSrc?: string, media?: Array<object>}} input
 * @returns {{url: string, platform: string, entry: object|null, source: "page"|"frame"|"sniffed"|"element"}|null}
 */
export function resolveOverlayCapture({ pageUrl, frameUrl, videoSrc, media } = {}) {
  const page = detectSupportedMediaUrl(pageUrl);
  if (page?.supported) {
    return { url: pageUrl, platform: page.platform, entry: null, source: "page" };
  }

  // A player embedded from a supported platform (a YouTube or Vimeo iframe on a
  // blog) is that platform's media, not the host page's.
  if (frameUrl && frameUrl !== pageUrl) {
    const frame = detectSupportedMediaUrl(frameUrl);
    if (frame?.supported) {
      return { url: frameUrl, platform: frame.platform, entry: null, source: "frame" };
    }
  }

  const list = Array.isArray(media) ? media.filter(Boolean) : [];
  if (isDirectMediaUrl(videoSrc)) {
    const match = list.find(entry => entry.url === videoSrc);
    if (match) return { url: match.url, platform: "generic", entry: match, source: "sniffed" };
  }

  const best = pickBestMedia(list);
  if (best) return { url: best.url, platform: "generic", entry: best, source: "sniffed" };

  if (isDirectMediaUrl(videoSrc)) {
    return { url: videoSrc, platform: "generic", entry: { mediaType: "video" }, source: "element" };
  }

  return null;
}
