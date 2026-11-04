// On-video "Download with OmniGet" button.
//
// Runs in the isolated world of every frame the extension already has host
// access to (see src/video-overlay-register.js). It only finds videos and draws
// the button; deciding what to send and sending it is the background's job, on
// the same path the popup and the Alt+O shortcut use.
//
// One button per frame, moved to whichever eligible video is under the
// pointer. Hover is computed from pointer coordinates against video rectangles
// rather than from mouseenter on the <video>, because most players lay a
// transparent control layer over the element and the video itself never sees
// the pointer.
(function omnigetVideoOverlay() {
  "use strict";

  if (globalThis.__omnigetVideoOverlayLoaded) return;
  globalThis.__omnigetVideoOverlayLoaded = true;

  const core = globalThis.OmniGetVideoOverlay;
  if (!core || typeof chrome === "undefined" || !chrome.runtime?.id) return;
  if (!core.isSupportedFrameUrl(location.href)) return;

  const HIDE_DELAY_MS = 600;
  const RESULT_VISIBLE_MS = 2600;

  const tr = (key, fallback) => {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  };

  const ICONS = {
    download: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3v10M6 9.5L10 13l4-3.5M4 16h12"/></svg>',
    sending: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path class="spin" d="M10 3a7 7 0 1 0 7 7"/></svg>',
    sent: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-8"/></svg>',
    error: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 2L1.5 17h17L10 2zm-.75 5.5h1.5v4h-1.5v-4zm.75 6.25a.75.75 0 100-1.5.75.75 0 000 1.5z"/></svg>',
  };

  const STYLE = `
    :host { all: initial; }
    .wrap {
      position: fixed;
      top: 0;
      left: 0;
      transform: translateX(-100%);
      display: none;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      letter-spacing: 0;
    }
    .wrap.shown { display: block; }
    .wrap.visible { opacity: 1; }
    .wrap.visible button { pointer-events: auto; }
    button {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      height: ${core.BUTTON_SIZE}px;
      min-width: ${core.BUTTON_SIZE}px;
      max-width: 100%;
      padding: 0 7px;
      border-radius: ${core.BUTTON_SIZE / 2}px;
      border: 1px solid rgba(255, 255, 255, 0.22);
      background: rgba(18, 18, 18, 0.78);
      color: #fff;
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      -webkit-backdrop-filter: blur(6px);
      backdrop-filter: blur(6px);
      transition: background-color 120ms ease, border-color 120ms ease;
    }
    button:hover, button:focus-visible { background: #f04e23; border-color: #f04e23; }
    button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
    button[data-state="sent"] { background: #2f9e55; border-color: #2f9e55; }
    button[data-state="error"] { background: #b3261e; border-color: #b3261e; }
    .icon { display: inline-flex; width: 14px; height: 14px; flex: none; }
    .icon svg { width: 14px; height: 14px; }
    .label {
      display: inline-block;
      max-width: 0;
      margin-left: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: max-width 180ms ease, margin-left 180ms ease;
    }
    button:hover .label, button:focus-visible .label, button[data-state] .label {
      max-width: 260px;
      margin-left: 6px;
    }
    .spin { transform-origin: 10px 10px; animation: omniget-spin 0.8s linear infinite; }
    @keyframes omniget-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .wrap, button, .label { transition: none; }
      .spin { animation: none; }
    }
  `;

  const videos = new Set();
  let observer = null;
  let started = false;
  let host = null;
  let wrap = null;
  let button = null;
  let iconEl = null;
  let labelEl = null;
  let current = null;
  let lastPointer = null;
  let pointerFrame = 0;
  let positionFrame = 0;
  let hideTimer = 0;
  let resultTimer = 0;
  let busy = false;
  let lastLayout = null;

  function contextAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  // --- Video discovery ------------------------------------------------------

  function track(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.localName === "video") {
      videos.add(node);
      return;
    }
    if (typeof node.getElementsByTagName !== "function") return;
    const found = node.getElementsByTagName("video");
    for (let i = 0; i < found.length; i++) videos.add(found[i]);
  }

  function onMutations(records) {
    for (const record of records) {
      for (const node of record.addedNodes) track(node);
    }
    if (current && !current.isConnected) hide(true);
  }

  // Players that build the <video> detached and only attach it on play are
  // picked up here too; media events do not bubble, so this listens in capture.
  function onMediaEvent(event) {
    if (event.target?.localName === "video") videos.add(event.target);
  }

  function describe(video) {
    const rect = video.getBoundingClientRect();
    return { rect, video };
  }

  function isEligible(video, rect) {
    let style = null;
    try {
      style = getComputedStyle(video);
    } catch {
      return false;
    }
    let hasMediaStream = false;
    try {
      const obj = video.srcObject;
      hasMediaStream = Boolean(obj) && typeof MediaStream !== "undefined" && obj instanceof MediaStream;
    } catch {
      hasMediaStream = false;
    }
    return core.isEligibleVideo({
      width: rect.width,
      height: rect.height,
      connected: video.isConnected,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      hasMediaStream,
    });
  }

  function findVideoAt(x, y) {
    const candidates = [];
    for (const video of videos) {
      if (!video.isConnected) {
        videos.delete(video);
        continue;
      }
      const { rect } = describe(video);
      if (!core.containsPoint(rect, x, y)) continue;
      candidates.push({ item: video, rect, eligible: isEligible(video, rect) });
    }
    return core.pickHoveredVideo(candidates, x, y);
  }

  // --- Button ---------------------------------------------------------------

  function ensureHost() {
    if (host) return;
    host = document.createElement("omniget-video-overlay");
    host.setAttribute(
      "style",
      "all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important;" +
        " width: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important;" +
        " border: 0 !important; z-index: 2147483647 !important; pointer-events: none !important;" +
        " display: block !important; transform: none !important;"
    );
    // Closed, so neither the site's CSS nor its scripts can reach inside.
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    wrap = document.createElement("div");
    wrap.className = "wrap";
    button = document.createElement("button");
    button.type = "button";
    iconEl = document.createElement("span");
    iconEl.className = "icon";
    labelEl = document.createElement("span");
    labelEl.className = "label";
    button.append(iconEl, labelEl);
    wrap.append(button);
    shadow.append(style, wrap);
    setState(null);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void send();
    });
    // Keep the player underneath from treating a press on the button as a
    // click on the video (play/pause, fullscreen on double click, menus).
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "touchstart", "touchend"]) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  function setState(state, text) {
    if (!button) return;
    if (state) button.dataset.state = state;
    else delete button.dataset.state;
    const label = text || tr("overlay_button_label", "Download with OmniGet");
    iconEl.innerHTML = ICONS[state] || ICONS.download;
    labelEl.textContent = label;
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  // Outside fullscreen the button lives on <html>. In fullscreen only the
  // fullscreen element's subtree is painted, so the button has to move inside
  // it — which is impossible when the <video> itself is what went fullscreen.
  function overlayParentFor(video) {
    const fs = fullscreenElement();
    if (!fs) return document.documentElement;
    if (fs === video || fs.localName === "video" || fs.localName === "iframe") return null;
    return fs.contains(video) ? fs : null;
  }

  function show(video) {
    const parent = overlayParentFor(video);
    if (!parent) {
      hide(true);
      return;
    }
    ensureHost();
    if (host.parentNode !== parent) parent.appendChild(host);
    current = video;
    wrap.classList.add("shown");
    updatePosition();
    // Next frame, so the opacity transition runs from the new position.
    requestAnimationFrame(() => {
      if (current === video && wrap) wrap.classList.add("visible");
    });
  }

  function hide(immediate) {
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (busy || resultTimer) {
      // Let the user read "Sent" or the error before the button goes away.
      if (!immediate) return;
    }
    current = null;
    lastLayout = null;
    if (positionFrame) cancelAnimationFrame(positionFrame);
    positionFrame = 0;
    if (wrap) wrap.classList.remove("visible", "shown");
  }

  function scheduleHide() {
    if (hideTimer || !current) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      hide(false);
    }, HIDE_DELAY_MS);
  }

  // A cheap per-frame loop while the button is showing keeps it glued to the
  // video through scrolling, resizing, sticky headers and CSS animations alike,
  // none of which reliably fire an event.
  function updatePosition() {
    positionFrame = 0;
    if (!current || !wrap) return;
    if (!current.isConnected) {
      hide(true);
      return;
    }
    const rect = current.getBoundingClientRect();
    const pos = core.computeButtonPosition(rect, { width: window.innerWidth, height: window.innerHeight });
    if (!pos || !isEligible(current, rect)) {
      wrap.classList.remove("shown", "visible");
      lastLayout = null;
    } else {
      const top = clearTopFor(current, pos);
      wrap.style.left = `${pos.anchorX}px`;
      wrap.style.top = `${top}px`;
      wrap.style.maxWidth = `${pos.maxWidth}px`;
      if (!wrap.classList.contains("shown")) {
        wrap.classList.add("shown", "visible");
      }
    }
    positionFrame = requestAnimationFrame(updatePosition);
  }

  // A sticky header or a cookie bar can sit on top of the video's top edge.
  // Slide the button down until its spot actually shows the player. The probe
  // only re-runs when the layout changed, not on every animation frame.

  function clearTopFor(video, pos) {
    const key = `${pos.anchorX}|${pos.top}|${pos.maxTop}`;
    if (lastLayout && lastLayout.video === video && lastLayout.key === key) return lastLayout.top;
    const x = pos.anchorX - core.BUTTON_SIZE / 2;
    const clear = core.findClearTop(pos.top, pos.maxTop, 8, (y) =>
      !isCoveredAt(video, x, y + 2) && !isCoveredAt(video, x, y + core.BUTTON_SIZE - 2)
    );
    // Fully covered (a modal, an ad): keep the default corner rather than vanish.
    const top = clear ?? pos.top;
    lastLayout = { video, key, top };
    return top;
  }

  function isCoveredAt(video, x, y) {
    let stack;
    try {
      stack = document.elementsFromPoint(x, y);
    } catch {
      return false;
    }
    for (const el of stack) {
      if (el === host) continue;
      return !belongsToPlayer(el, video);
    }
    return false;
  }

  // The video itself, its wrappers, and siblings within a few levels (control
  // bars, click-catching layers) count as the player, not as covering it.
  function belongsToPlayer(el, video) {
    if (el === video || el.contains(video)) return true;
    let ancestor = video.parentElement;
    for (let i = 0; i < 3 && ancestor; i++, ancestor = ancestor.parentElement) {
      if (ancestor === document.body || ancestor === document.documentElement) break;
      if (ancestor.contains(el)) return true;
    }
    return false;
  }

  // --- Pointer --------------------------------------------------------------

  function onPointer(event) {
    lastPointer = { x: event.clientX, y: event.clientY };
    if (!pointerFrame) pointerFrame = requestAnimationFrame(evaluatePointer);
  }

  function evaluatePointer() {
    pointerFrame = 0;
    if (!lastPointer) return;
    const video = findVideoAt(lastPointer.x, lastPointer.y);
    if (video) {
      clearTimeout(hideTimer);
      hideTimer = 0;
      if (video !== current) show(video);
    } else {
      scheduleHide();
    }
  }

  function onPointerOut(event) {
    if (!event.relatedTarget) {
      lastPointer = null;
      scheduleHide();
    }
  }

  function onFullscreenChange() {
    if (!current) return;
    const video = current;
    hide(true);
    show(video);
  }

  // --- Sending --------------------------------------------------------------

  function errorText(reason) {
    if (reason === "no_media") return tr("overlay_no_media", "No video found yet — play it, then try again");
    if (reason === "manifest_gone") return tr("popup_manifest_gone", "This playlist came from a page that has since reloaded — reopen it");
    return tr("popup_not_running", "OmniGet is not running");
  }

  async function send() {
    if (busy || !current) return;
    if (!contextAlive()) {
      stop();
      return;
    }
    const video = current;
    busy = true;
    clearTimeout(resultTimer);
    resultTimer = 0;
    setState("sending", tr("popup_sending", "Sending…"));

    let response = null;
    try {
      const sources = Array.from(video.querySelectorAll("source"), (source) => source.src);
      response = await chrome.runtime.sendMessage({
        type: "overlaySendToOmniGet",
        videoSrc: core.pickDirectSource(video.currentSrc, video.src, sources),
      });
    } catch {
      response = null;
    }
    busy = false;

    if (response?.ok) setState("sent", tr("popup_sent", "Sent!"));
    else setState("error", errorText(response?.reason));

    resultTimer = setTimeout(() => {
      resultTimer = 0;
      setState(null);
      if (!lastPointer || findVideoAt(lastPointer.x, lastPointer.y) !== current) scheduleHide();
    }, RESULT_VISIBLE_MS);
  }

  // --- Lifecycle ------------------------------------------------------------

  function start() {
    if (started) return;
    started = true;
    track(document.documentElement);
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("pointermove", onPointer, { capture: true, passive: true });
    document.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
    document.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });
    document.addEventListener("loadedmetadata", onMediaEvent, true);
    document.addEventListener("play", onMediaEvent, true);
    document.addEventListener("fullscreenchange", onFullscreenChange, true);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange, true);
  }

  function stop() {
    if (!started) return;
    started = false;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("pointermove", onPointer, { capture: true });
    document.removeEventListener("pointerdown", onPointer, { capture: true });
    document.removeEventListener("pointerout", onPointerOut, { capture: true });
    document.removeEventListener("loadedmetadata", onMediaEvent, true);
    document.removeEventListener("play", onMediaEvent, true);
    document.removeEventListener("fullscreenchange", onFullscreenChange, true);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange, true);
    clearTimeout(resultTimer);
    resultTimer = 0;
    busy = false;
    hide(true);
    host?.remove();
    host = null;
    wrap = null;
    button = null;
    videos.clear();
  }

  function apply(enabled) {
    if (enabled) start();
    else stop();
  }

  try {
    chrome.storage.local
      .get(core.STORAGE_KEY)
      .then((stored) => apply(core.isOverlayEnabled(stored?.[core.STORAGE_KEY])))
      .catch(() => apply(core.DEFAULT_ENABLED));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes || !(core.STORAGE_KEY in changes)) return;
      apply(core.isOverlayEnabled(changes[core.STORAGE_KEY].newValue));
    });
  } catch {
    apply(core.DEFAULT_ENABLED);
  }
})();
