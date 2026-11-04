// Pure helpers for the on-video download button.
//
// This is a classic script, not a module, because content scripts cannot be
// ES modules: it is injected right before src/video-overlay.js and shares that
// script's isolated world through a single frozen global. The options page and
// the unit tests load it with a side-effect import and read the same global, so
// the storage key and its default live in exactly one place.
(function defineOmniGetVideoOverlay(root) {
  "use strict";

  const STORAGE_KEY = "omniget_video_overlay_enabled";
  const DEFAULT_ENABLED = true;

  // Below this a video is a thumbnail preview, an avatar loop or an ad slot,
  // and a button on it would cover most of what the user is looking at.
  const MIN_VIDEO_WIDTH = 200;
  const MIN_VIDEO_HEIGHT = 112;

  // Collapsed button size and its distance from the video's edges. The button
  // only ever sits in the top-right corner, away from the control bar every
  // mainstream player draws along the bottom edge.
  const BUTTON_SIZE = 30;
  const BUTTON_MARGIN = 10;

  /** The option is on unless the user explicitly switched it off. */
  function isOverlayEnabled(storedValue) {
    return storedValue !== false;
  }

  /** Only real web documents get the button; about:blank, srcdoc, data: and
   * extension frames are skipped. */
  function isSupportedFrameUrl(href) {
    if (typeof href !== "string") return false;
    return /^https?:\/\//i.test(href);
  }

  /**
   * @param {{width?: number, height?: number, connected?: boolean, display?: string,
   *   visibility?: string, opacity?: number, hasMediaStream?: boolean}} info
   * @param {{minWidth?: number, minHeight?: number}} [options]
   */
  function isEligibleVideo(info, options = {}) {
    if (!info || info.connected === false) return false;
    const minWidth = options.minWidth ?? MIN_VIDEO_WIDTH;
    const minHeight = options.minHeight ?? MIN_VIDEO_HEIGHT;
    const width = Number(info.width);
    const height = Number(info.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (width < minWidth || height < minHeight) return false;
    if (info.display === "none") return false;
    if (info.visibility === "hidden" || info.visibility === "collapse") return false;
    if (typeof info.opacity === "number" && Number.isFinite(info.opacity) && info.opacity <= 0.05) return false;
    // A camera or screen-share preview (srcObject = MediaStream) is never
    // something to download.
    if (info.hasMediaStream) return false;
    return true;
  }

  function intersectRect(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function containsPoint(rect, x, y) {
    if (!rect) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /**
   * Where the button goes, in viewport coordinates. `anchorX` is the button's
   * right edge (it grows leftwards when it expands) and `top` its top edge. The
   * corner follows the part of the video that is actually on screen, so a
   * player scrolled half out of view still shows the button inside it.
   *
   * @param {{left: number, top: number, right?: number, bottom?: number, width?: number, height?: number}} videoRect
   * @param {{width: number, height: number}} viewport
   * @param {{size?: number, margin?: number}} [options]
   * @returns {{anchorX: number, top: number, maxWidth: number}|null} null when there is no room
   */
  function computeButtonPosition(videoRect, viewport, options = {}) {
    if (!videoRect || !viewport) return null;
    const size = options.size ?? BUTTON_SIZE;
    const margin = options.margin ?? BUTTON_MARGIN;
    const rect = normalizeRect(videoRect);
    const screen = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
    const visible = intersectRect(rect, screen);
    if (!visible) return null;
    if (visible.width < size + margin * 2 || visible.height < size + margin * 2) return null;
    return {
      anchorX: Math.round(visible.right - margin),
      top: Math.round(visible.top + margin),
      maxWidth: Math.floor(visible.width - margin * 2),
      // Lowest top that still keeps the whole button inside the visible part.
      maxTop: Math.round(visible.bottom - margin - size),
    };
  }

  /**
   * First top offset, scanning down from `top` in `step` px increments up to
   * `maxTop`, where `isClear(top)` holds. Used to slide the button below
   * something that covers the video's top edge, such as a sticky site header.
   * Returns null when no position is clear.
   * @param {number} top
   * @param {number} maxTop
   * @param {number} step
   * @param {(top: number) => boolean} isClear
   * @returns {number|null}
   */
  function findClearTop(top, maxTop, step, isClear) {
    if (!Number.isFinite(top) || !Number.isFinite(maxTop) || typeof isClear !== "function") return null;
    const stride = step > 0 ? step : BUTTON_SIZE;
    for (let y = top; y <= maxTop; y += stride) {
      if (isClear(y)) return y;
    }
    if (maxTop > top && (maxTop - top) % stride !== 0 && isClear(maxTop)) return maxTop;
    return null;
  }

  function normalizeRect(r) {
    const left = Number(r.left) || 0;
    const top = Number(r.top) || 0;
    const right = Number.isFinite(r.right) ? r.right : left + (Number(r.width) || 0);
    const bottom = Number.isFinite(r.bottom) ? r.bottom : top + (Number(r.height) || 0);
    return { left, top, right, bottom };
  }

  /**
   * The video under the pointer. Nested players (a preview inside a hero
   * banner) resolve to the smallest one that contains the point.
   * @template T
   * @param {Array<{item: T, rect: object, eligible: boolean}>} candidates
   * @returns {T|null}
   */
  function pickHoveredVideo(candidates, x, y) {
    let best = null;
    let bestArea = Infinity;
    for (const candidate of candidates || []) {
      if (!candidate?.eligible) continue;
      const rect = normalizeRect(candidate.rect);
      if (!containsPoint(rect, x, y)) continue;
      const area = (rect.right - rect.left) * (rect.bottom - rect.top);
      if (area < bestArea) {
        best = candidate.item;
        bestArea = area;
      }
    }
    return best;
  }

  /**
   * The element's own media URL, when it has a plain http(s) one. A blob: or
   * MediaSource URL means the page assembles the stream itself, and only the
   * sniffer's captures can describe it.
   */
  function pickDirectSource(currentSrc, src, sourceUrls) {
    const all = [currentSrc, src, ...(Array.isArray(sourceUrls) ? sourceUrls : [])];
    for (const url of all) {
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
    }
    return "";
  }

  root.OmniGetVideoOverlay = Object.freeze({
    STORAGE_KEY,
    DEFAULT_ENABLED,
    MIN_VIDEO_WIDTH,
    MIN_VIDEO_HEIGHT,
    BUTTON_SIZE,
    BUTTON_MARGIN,
    isOverlayEnabled,
    isSupportedFrameUrl,
    isEligibleVideo,
    intersectRect,
    containsPoint,
    computeButtonPosition,
    findClearTop,
    pickHoveredVideo,
    pickDirectSource,
  });
})(globalThis);
