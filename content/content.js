/**
 * Content script for recorder.google.com
 * Automates: list → open → ⋮ Settings → Download → Text (.txt) only
 */
(() => {
  if (window.__recorderTranscriptBatch) return;
  window.__recorderTranscriptBatch = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function allDeep(root = document.documentElement) {
    const out = [];
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      out.push(node);
      if (node.shadowRoot) {
        for (const c of node.shadowRoot.children) walk(c);
      }
      for (const c of node.children) walk(c);
    };
    walk(root);
    return out;
  }

  // Intercept anchor clicks on the page (capture phase) to grab client-side generated blob downloads
  let capturedBlobUrl = null;
  let capturedFilename = null;
  let latestCapturedText = null;
  let latestCapturedUrl = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "recorder-main-interceptor") return;
    if (event.data.type === "blob_created") {
      console.log("[Recorder Content] Intercepted transcript blob text! Length:", event.data.text?.length);
      latestCapturedText = event.data.text;
      latestCapturedUrl = event.data.url;
    }
    if (event.data.type === "anchor_click") {
      console.log("[Recorder Content] Intercepted anchor click:", event.data.download, event.data.href?.slice(0, 80));
      capturedFilename = event.data.download;
      capturedBlobUrl = event.data.href;
    }
  });

  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest ? e.target.closest("a") : (e.target.tagName === "A" ? e.target : null);
      if (a && (a.download || a.href?.startsWith("blob:") || a.href?.startsWith("data:"))) {
        console.log("[Recorder Interceptor] Caught download anchor click:", a.download, a.href?.slice(0, 80));
        capturedBlobUrl = a.href;
        capturedFilename = a.download;
      }
    },
    true
  );

  async function fetchCapturedBlob(url) {
    try {
      const res = await fetch(url);
      return await res.text();
    } catch (err) {
      console.warn("[Recorder] Could not fetch captured blob URL:", err);
      return null;
    }
  }

  function pressEscape() {
    for (let i = 0; i < 2; i++) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
      );
      document.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true })
      );
    }
  }

  const MONTHS = {
    Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
    Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
  };

  /** Parse "2026 Jul 17", "Jul 17, 2026", or "Oct 1" → local midnight Date, or null. */
  function parseRecorderLabel(label) {
    if (!label) return null;
    const s = String(label).trim();
    const m = /(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})/.exec(s);
    if (m) {
      const mon = MONTHS[m[2].slice(0, 3)];
      if (!mon) return null;
      const d = new Date(Number(m[1]), mon - 1, Number(m[3]));
      if (Number.isNaN(d.getTime())) return null;
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const m2 = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
    if (m2) {
      const mon = MONTHS[m2[1].slice(0, 3)];
      if (!mon) return null;
      const d = new Date(Number(m2[3]), mon - 1, Number(m2[2]));
      if (Number.isNaN(d.getTime())) return null;
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const m3 = /([A-Za-z]+)\s+(\d{1,2})/.exec(s);
    if (m3) {
      const mon = MONTHS[m3[1].slice(0, 3)];
      if (mon) {
        const d = new Date(new Date().getFullYear(), mon - 1, Number(m3[2]));
        if (!Number.isNaN(d.getTime())) {
          d.setHours(0, 0, 0, 0);
          return d;
        }
      }
    }
    return null;
  }

  function parseISODate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function scrapeSidebarItems() {
    const items = [];
    for (const el of allDeep()) {
      if (
        !(
          el.classList &&
          el.classList.contains("item") &&
          el.getAttribute("role") === "button"
        )
      ) {
        continue;
      }
      let title = "";
      let created = "";
      let duration = "";
      for (const d of allDeep(el)) {
        const a = d.getAttribute?.("aria-label") || "";
        if (a.startsWith("Created on ")) created = a.replace("Created on ", "").trim();
        if (a.startsWith("Duration is ")) duration = a;
        if (d.classList && d.classList.contains("title")) {
          title = (d.innerText || "").trim();
        }
      }
      if (!title) {
        const cont = allDeep(el).find(
          (x) => x.classList && x.classList.contains("container")
        );
        if (cont) title = (cont.innerText || "").trim().split("\n")[0].trim();
      }
      if (!title) title = (el.innerText || "").trim().split("\n")[0].trim();
      items.push({
        title,
        created,
        duration,
        selected: el.classList.contains("selected"),
      });
    }
    return items;
  }

  function clickLoadMore() {
    for (const el of allDeep()) {
      const t = (el.innerText || "").trim();
      const r = el.getBoundingClientRect();
      if (
        t === "Load more" &&
        r.width > 0 &&
        r.height > 0 &&
        (el.tagName === "BUTTON" || el.tagName === "MWC-BUTTON")
      ) {
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      }
    }
    return false;
  }

  function getSidebarScrollContainers() {
    const containers = [];
    const maxLeftX = Math.min(window.innerWidth * 0.6, 650);
    for (const el of allDeep()) {
      if (!el || !el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (r.left < maxLeftX && r.width >= 120 && r.width <= 650 && r.height > 100) {
        if (el.scrollHeight > el.clientHeight + 20) {
          containers.push(el);
        }
      }
    }
    return containers;
  }

  function scrollAllSidebar(posOrDelta, isAbsolute = false) {
    const containers = getSidebarScrollContainers();
    let scrolledAny = false;
    for (const c of containers) {
      const prev = c.scrollTop;
      if (isAbsolute) {
        c.scrollTop = posOrDelta;
      } else {
        c.scrollTop = prev + posOrDelta;
      }
      if (c.scrollTop !== prev) scrolledAny = true;
    }
    return scrolledAny;
  }

  function scrollSidebarDown() {
    const containers = getSidebarScrollContainers();
    for (const c of containers) {
      c.scrollTop = c.scrollHeight;
    }
  }

  /**
   * List sidebar items. Recorder is newest-first — stop loading once the
   * oldest visible "Created on" date is strictly before the range start.
   * Further pages can only be older and cannot match.
   */
  async function listRecordings({ startISO, endISO, labels } = {}) {
    const start = parseISODate(startISO);
    const end = parseISODate(endISO);
    const labelSet = new Set(labels || []);
    const startMs = start ? start.getTime() : null;
    const endMs = end ? end.getTime() : null;

    let items = [];
    let stable = 0;
    let prevCount = -1;
    let stopReason = "max_passes";

    // Cap still exists as a safety net; early-stop usually exits much sooner.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (jobCancel) throw new Error("Cancelled");

      items = scrapeSidebarItems();

      // Dedup as we go (stable identity)
      const seen = new Set();
      const unique = [];
      for (const it of items) {
        const key = `${it.title}||${it.created}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(it);
      }
      items = unique;

      // Parse dates; find oldest visible (list is newest → oldest)
      let oldestMs = null;
      let newestMs = null;
      let datedCount = 0;
      let matchCount = 0;
      for (const it of items) {
        const d = parseRecorderLabel(it.created);
        if (d) {
          datedCount += 1;
          const t = d.getTime();
          if (oldestMs === null || t < oldestMs) oldestMs = t;
          if (newestMs === null || t > newestMs) newestMs = t;
          if (startMs != null && endMs != null && t >= startMs && t <= endMs) {
            matchCount += 1;
          } else if (startMs == null && labelSet.has(it.created)) {
            matchCount += 1;
          }
        } else if (labelSet.has(it.created)) {
          matchCount += 1;
        }
      }

      // Early stop: oldest item is older than range start → everything
      // further down is also older (sorted newest-first).
      const pastRangeStart =
        startMs != null && oldestMs != null && oldestMs < startMs;

      send({
        type: "list_progress",
        attempt: attempt + 1,
        count: items.length,
        matchCount,
        datedCount,
        oldestLabel:
          oldestMs != null
            ? items.map((i) => i.created).filter(Boolean).slice(-1)[0] || null
            : null,
        pastRangeStart,
        loadMore: false,
      });

      if (pastRangeStart) {
        stopReason = "past_range_start";
        send({
          type: "status",
          message: `List complete (passed date range after ${items.length} items, ${matchCount} match(es))`,
        });
        break;
      }

      // Need more history: scroll + Load more only if still inside/above range
      const clicked = clickLoadMore();
      if (clicked) await sleep(1200);
      scrollSidebarDown();
      await sleep(clicked ? 500 : 400);

      // Re-scrape after load/scroll for stable comparison
      const after = scrapeSidebarItems();
      const afterCount = after.length;

      send({
        type: "list_progress",
        attempt: attempt + 1,
        count: afterCount,
        matchCount,
        loadMore: clicked,
        pastRangeStart: false,
      });

      if (afterCount === prevCount && !clicked) {
        stable += 1;
      } else {
        stable = 0;
      }
      prevCount = afterCount;

      if (stable >= 2) {
        stopReason = "list_exhausted";
        items = after;
        // final dedup
        const s2 = new Set();
        const u2 = [];
        for (const it of after) {
          const key = `${it.title}||${it.created}`;
          if (s2.has(key)) continue;
          s2.add(key);
          u2.push(it);
        }
        items = u2;
        break;
      }

      // Use post-scroll items for next loop iteration
      items = after;
    }

    // Final dedup
    const seen = new Set();
    const unique = [];
    for (const it of items) {
      const key = `${it.title}||${it.created}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(it);
    }

    send({
      type: "list_progress",
      attempt: "done",
      count: unique.length,
      stopReason,
    });

    return { items: unique, stopReason };
  }

  function filterMatches(items, { startISO, endISO, labels }) {
    const start = parseISODate(startISO);
    const end = parseISODate(endISO);
    const labelSet = new Set(labels || []);
    const startMs = start ? start.getTime() : null;
    const endMs = end ? end.getTime() : null;

    return items.filter((it) => {
      const d = parseRecorderLabel(it.created);
      if (d && startMs != null && endMs != null) {
        const t = d.getTime();
        return t >= startMs && t <= endMs;
      }
      // Fallback: exact Created-on label strings from the SW
      return labelSet.has(it.created);
    });
  }

  function scrollSidebarToTop() {
    scrollAllSidebar(0, true);
  }

  function normalizeText(s) {
    if (!s) return "";
    return String(s)
      .replace(/[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\.\.\.$/, "")
      .trim()
      .toLowerCase();
  }

  function normalizeTimeTitle(s) {
    return normalizeText(s).replace(/\b0(\d:\d\d)\b/g, "$1");
  }

  function titlesMatch(a, b) {
    const na = normalizeTimeTitle(a);
    const nb = normalizeTimeTitle(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.startsWith(nb) || nb.startsWith(na)) return true;
    return false;
  }

  function datesMatch(domCreated, targetCreated) {
    if (!domCreated || !targetCreated) return true;
    const nd = normalizeText(domCreated);
    const nt = normalizeText(targetCreated);
    if (nd === nt) return true;
    if (nd.includes(nt) || nt.includes(nd)) return true;

    // Compare parsed dates if both parseable
    const d1 = parseRecorderLabel(domCreated);
    const d2 = parseRecorderLabel(targetCreated);
    if (d1 && d2) {
      return d1.getTime() === d2.getTime();
    }
    // Also check if month and day match (e.g. "oct 1" in "2026 oct 1")
    const m1 = /([a-z]{3})\s*(\d{1,2})/.exec(nd);
    const m2 = /([a-z]{3})\s*(\d{1,2})/.exec(nt);
    if (m1 && m2 && m1[1] === m2[1] && m1[2] === m2[2]) {
      return true;
    }
    return false;
  }

  function itemMatchesTarget(el, targetTitle, targetCreated) {
    let domTitle = "";
    let domCreated = "";
    for (const d of allDeep(el)) {
      const a = d.getAttribute?.("aria-label") || "";
      if (a.startsWith("Created on ")) domCreated = a.replace("Created on ", "").trim();
      if (d.classList && d.classList.contains("title")) domTitle = (d.innerText || "").trim();
    }
    if (!domTitle) {
      const cont = allDeep(el).find(
        (x) => x.classList && x.classList.contains("container")
      );
      if (cont) domTitle = (cont.innerText || "").trim().split("\n")[0].trim();
    }
    if (!domTitle) domTitle = (el.innerText || "").trim().split("\n")[0].trim();

    const dateOk = datesMatch(domCreated, targetCreated);

    // 1. Direct title match
    if (titlesMatch(domTitle, targetTitle) && dateOk) {
      return true;
    }

    // 2. Check full text of element
    const fullText = normalizeTimeTitle(el.innerText || "");
    const targetNorm = normalizeTimeTitle(targetTitle);
    if (fullText.includes(targetNorm) && dateOk) {
      return true;
    }

    // 3. Check aria-label of element or its children
    for (const d of allDeep(el)) {
      const a = d.getAttribute?.("aria-label");
      if (a && normalizeTimeTitle(a).includes(targetNorm) && dateOk) {
        return true;
      }
    }

    // 4. If title is a very strong match (>6 chars), accept even if date was slightly off/missing
    if (normalizeTimeTitle(domTitle) === targetNorm && targetNorm.length > 6) {
      return true;
    }

    return false;
  }

  function findVisibleSidebarItem(title, created) {
    for (const el of allDeep()) {
      if (
        !(
          el.classList &&
          el.classList.contains("item") &&
          el.getAttribute &&
          el.getAttribute("role") === "button"
        )
      ) {
        continue;
      }
      if (itemMatchesTarget(el, title, created)) {
        return el;
      }
    }
    return null;
  }

  async function doClickItem(el, fast = false) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (!fast) await sleep(200);

    const clickTarget =
      allDeep(el).find((x) => x.classList && x.classList.contains("container")) || el;
    const clickOpts = { bubbles: true, cancelable: true, view: window };
    clickTarget.dispatchEvent(new PointerEvent("pointerdown", clickOpts));
    clickTarget.dispatchEvent(new MouseEvent("mousedown", clickOpts));
    clickTarget.dispatchEvent(new PointerEvent("pointerup", clickOpts));
    clickTarget.dispatchEvent(new MouseEvent("mouseup", clickOpts));
    clickTarget.click();

    if (fast) return true; // caller polls for readiness and re-clicks if needed
    await sleep(250);
    if (!el.classList.contains("selected") && clickTarget !== el) {
      el.dispatchEvent(new PointerEvent("pointerdown", clickOpts));
      el.dispatchEvent(new MouseEvent("mousedown", clickOpts));
      el.dispatchEvent(new PointerEvent("pointerup", clickOpts));
      el.dispatchEvent(new MouseEvent("mouseup", clickOpts));
      el.click();
    }
    return true;
  }

  async function clickSidebarItem(title, created, fast = false) {
    const nap = (ms) => sleep(fast ? 50 : ms);
    // 1. Check if already rendered in current DOM viewport
    let el = findVisibleSidebarItem(title, created);
    if (el) {
      return doClickItem(el, fast);
    }

    // 2. If not visible, reset sidebar to top and check
    scrollSidebarToTop();
    await nap(300);
    el = findVisibleSidebarItem(title, created);
    if (el) {
      return doClickItem(el, fast);
    }

    // 3. Scroll down in 300px chunks and check
    const maxScrollSteps = 45;
    for (let s = 0; s < maxScrollSteps; s++) {
      const moved = scrollAllSidebar(300, false);
      await nap(250);
      el = findVisibleSidebarItem(title, created);
      if (el) {
        return doClickItem(el, fast);
      }
      if (!moved && s > 3) {
        break; // reached bottom of all containers
      }
    }

    // 4. Check if "Load more" exists and click it if available
    if (clickLoadMore()) {
      await nap(1000);
      el = findVisibleSidebarItem(title, created);
      if (el) return doClickItem(el, fast);
    }

    // 5. Diagnostics if still not found
    const visibleTitles = [];
    for (const item of allDeep()) {
      if (item.classList && item.classList.contains("item") && item.getAttribute?.("role") === "button") {
        let t = "";
        for (const d of allDeep(item)) {
          if (d.classList && d.classList.contains("title")) t = (d.innerText || "").trim();
        }
        if (t) visibleTitles.push(t);
      }
    }
    console.warn(
      `[Recorder] Failed to find item: "${title}" (${created}). Currently visible titles (${visibleTitles.length}):`,
      visibleTitles
    );
    return false;
  }

  async function waitForRecordingReady(expectedTitle, timeoutMs = 15000) {
    const start = Date.now();
    const normExpected = normalizeTimeTitle(expectedTitle || "");

    // Give Google Recorder time to register the sidebar click
    await sleep(800);

    let reclickDone = false;
    while (Date.now() - start < timeoutMs) {
      if (jobCancel) break;

      // Check if any spinner or loading bar is active
      let isLoading = false;
      for (const el of allDeep()) {
        const tag = el.tagName || "";
        if (tag === "MWC-CIRCULAR-PROGRESS" || tag === "MWC-LINEAR-PROGRESS" || el.classList?.contains("loading")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            isLoading = true;
            break;
          }
        }
      }

      // Check for Settings button in player header (must be to the right of sidebar)
      let settingsFound = false;
      for (const el of allDeep()) {
        if (el.getAttribute?.("aria-label") === "Settings" && el.tagName === "BUTTON") {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.left > 200) {
            settingsFound = true;
            break;
          }
        }
      }

      // Check if main panel contains the expected title
      let titleFound = false;
      if (normExpected) {
        for (const el of allDeep()) {
          const r = el.getBoundingClientRect();
          if (r.left < 200 || r.width <= 0) continue;
          const t = normalizeTimeTitle(el.value || el.innerText || "");
          if (t && (t.includes(normExpected) || normExpected.includes(t))) {
            titleFound = true;
            break;
          }
        }
      } else {
        titleFound = true;
      }

      if (settingsFound && !isLoading && (titleFound || (normExpected && Date.now() - start > 6000))) {
        // Player is ready! Settle to ensure all MWC listeners are attached
        await sleep(1000);
        return true;
      }

      // If title not found after 3.5s, re-click sidebar item
      if (normExpected && !titleFound && Date.now() - start > 3500 && !reclickDone) {
        reclickDone = true;
        console.log(`[Recorder] Re-clicking sidebar item for "${expectedTitle}"...`);
        const itemEl = findVisibleSidebarItem(expectedTitle, "");
        if (itemEl) {
          await doClickItem(itemEl);
        }
      }

      await sleep(250);
    }
    await sleep(800);
    return true;
  }

  function isModalOrMenuOpen() {
    for (const el of allDeep()) {
      if (el.tagName === "MWC-DIALOG") {
        if ((el.open || el.hasAttribute("open")) && el.getBoundingClientRect().height > 0) {
          return true;
        }
        continue;
      }
      if (
        (el.innerText || "").includes("Select file format") &&
        el.getBoundingClientRect().width > 0 &&
        el.getBoundingClientRect().height > 0
      ) {
        const style = window.getComputedStyle(el);
        if (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") {
          return true;
        }
      }
    }
    return false;
  }

  async function downloadCurrentTxt(suggestedName) {
    capturedBlobUrl = null;
    capturedFilename = null;
    latestCapturedText = null;
    latestCapturedUrl = null;

    if (isModalOrMenuOpen()) {
      pressEscape();
      await sleep(400);
    }

    let settings = null;
    for (const el of allDeep()) {
      if (el.getAttribute?.("aria-label") === "Settings" && el.tagName === "BUTTON") {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.left > 200) {
          settings = el;
          break;
        }
      }
    }
    if (!settings) throw new Error("Settings (⋮) button not found");

    const clickOpts = { bubbles: true, cancelable: true, view: window };
    settings.scrollIntoView({ block: "center" });
    settings.dispatchEvent(new PointerEvent("pointerdown", clickOpts));
    settings.dispatchEvent(new MouseEvent("mousedown", clickOpts));
    settings.dispatchEvent(new PointerEvent("pointerup", clickOpts));
    settings.dispatchEvent(new MouseEvent("mouseup", clickOpts));
    settings.click();
    await sleep(800);

    const menuCandidates = [];
    for (const el of allDeep()) {
      const t = (el.innerText || "").trim();
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (t !== "Download") continue;
      const role = el.getAttribute?.("role") || "";
      if (role === "menuitem" || el.tagName.includes("LIST-ITEM") || el.classList?.contains("mdc-list-item")) {
        const score = (role === "menuitem" ? 100 : 0) + (el.tagName.includes("LIST-ITEM") ? 50 : 0);
        menuCandidates.push({ el, score });
      }
    }
    menuCandidates.sort((a, b) => b.score - a.score);
    if (!menuCandidates.length) throw new Error("Download menu item not found in Settings menu");
    menuCandidates[0].el.scrollIntoView({ block: "center" });
    menuCandidates[0].el.dispatchEvent(new PointerEvent("pointerdown", clickOpts));
    menuCandidates[0].el.dispatchEvent(new MouseEvent("mousedown", clickOpts));
    menuCandidates[0].el.dispatchEvent(new PointerEvent("pointerup", clickOpts));
    menuCandidates[0].el.dispatchEvent(new MouseEvent("mouseup", clickOpts));
    menuCandidates[0].el.click();
    await sleep(1000);

    let dialogOk = false;
    for (let i = 0; i < 15; i++) {
      for (const el of allDeep()) {
        if ((el.innerText || "").trim() === "Select file format") {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            dialogOk = true;
            break;
          }
        }
      }
      if (dialogOk) break;
      await sleep(200);
    }
    if (!dialogOk) throw new Error("Format dialog did not open");

    // Configure checkboxes: Text file ON, Audio file OFF
    for (let attempt = 0; attempt < 8; attempt++) {
      const rows = [];
      for (const el of allDeep()) {
        if (el.tagName !== "MWC-CHECK-LIST-ITEM") continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const text = (el.innerText || "").trim();
        const on = el.getAttribute("aria-checked") === "true" || !!el.selected;
        rows.push({ el, text, on });
      }
      const audio = rows.find((x) => /Audio file/i.test(x.text));
      const textRow = rows.find((x) => /Text file/i.test(x.text));
      let toggled = false;
      if (audio?.on) {
        audio.el.click();
        toggled = true;
      }
      if (textRow && !textRow.on) {
        textRow.el.click();
        toggled = true;
      }
      if (!toggled && textRow?.on && !audio?.on) {
        break;
      }
      await sleep(350);
    }

    await sleep(300);

    // Find Dialog Download button
    let dlBtn = null;
    for (const el of allDeep()) {
      const t = (el.innerText || "").trim();
      if (t !== "Download") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const role = el.getAttribute?.("role") || "";
      if (role === "menuitem") continue;
      if (el.tagName === "MWC-BUTTON" || el.getAttribute("dialogAction") === "ok" || el.getAttribute("slot") === "primaryAction") {
        dlBtn = el;
        break;
      }
      if (el.tagName === "BUTTON" && (el.innerText || "").trim() === "Download") {
        dlBtn = el;
      }
    }
    if (!dlBtn) throw new Error("Dialog Download button not found");

    if (dlBtn.hasAttribute("disabled") || dlBtn.disabled) {
      await sleep(600);
      if (dlBtn.hasAttribute("disabled") || dlBtn.disabled) {
        throw new Error("Dialog Download button is disabled (Text file format was not selected)");
      }
    }

    const clickTarget = dlBtn.shadowRoot?.querySelector("button") || dlBtn;
    clickTarget.dispatchEvent(new PointerEvent("pointerdown", clickOpts));
    clickTarget.dispatchEvent(new MouseEvent("mousedown", clickOpts));
    clickTarget.dispatchEvent(new PointerEvent("pointerup", clickOpts));
    clickTarget.dispatchEvent(new MouseEvent("mouseup", clickOpts));
    clickTarget.click();

    // Do NOT press Escape! Let Google Recorder process the download and close dialog naturally.
    await sleep(800);
    return true;
  }

  let jobCancel = false;
  let jobPaused = false;
  let jobRunning = false;
  let pendingTargets = null;
  let continueResolver = null;
  let pauseResolver = null;

  // ---- Experimental: read the Transcript view directly ----
  function findTranscriptButton() {
    return (
      allDeep().find(
        (el) =>
          el.tagName === "BUTTON" &&
          el.getAttribute("role") === "radio" &&
          (el.classList.contains("transcript") ||
            /transcript view/i.test(el.getAttribute("aria-label") || ""))
      ) || null
    );
  }

  function findTranscriptContainer() {
    return (
      allDeep().find(
        (el) =>
          el.getAttribute?.("aria-label") === "Recording transcript" &&
          el.classList.contains("scroll-container")
      ) || null
    );
  }

  // innerText/textContent don't reach into shadow roots, so walk them (and slots) by hand,
  // using computed styles to approximate on-screen line breaks.
  function deepText(root) {
    // Returns { t, inline }: inline results are concatenated into one line by their block parent.
    const walk = (node) => {
      if (node.nodeType === 3) return { t: node.nodeValue.replace(/\s+/g, " "), inline: true };
      if (node.nodeType !== 1) return { t: "", inline: true };
      const tag = node.tagName;
      if (tag === "STYLE" || tag === "SCRIPT" || tag === "NOSCRIPT") return { t: "", inline: true };
      const cs = getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") return { t: "", inline: true };
      let kids;
      if (tag === "SLOT") {
        const assigned = node.assignedNodes({ flatten: true });
        kids = assigned.length ? assigned : [...node.childNodes];
      } else if (node.shadowRoot) {
        kids = [...node.shadowRoot.childNodes];
      } else {
        kids = [...node.childNodes];
      }
      const parts = kids.map(walk);
      if (cs.display === "inline" || cs.display === "contents") {
        return { t: parts.map((p) => p.t).join(""), inline: true };
      }
      const rowFlex = cs.display.includes("flex") && !cs.flexDirection.startsWith("column");
      let text;
      if (rowFlex) {
        text = parts.map((p) => p.t.trim()).filter(Boolean).join(" ");
      } else {
        const lines = [];
        let buf = "";
        const flush = () => {
          const l = buf.replace(/[ \t]+/g, " ").trim();
          if (l) lines.push(l);
          buf = "";
        };
        for (const p of parts) {
          if (p.inline) {
            buf += p.t;
          } else {
            flush();
            if (p.t.trim()) lines.push(p.t.trim());
          }
        }
        flush();
        text = lines.join("\n");
      }
      // inline-block / inline-flex etc. sit inside a line: pad so adjacent words don't fuse
      if (cs.display.startsWith("inline")) return { t: " " + text + " ", inline: true };
      return { t: text, inline: false };
    };
    return walk(root).t;
  }

  function mainPanelHasTitle(normExpected) {
    for (const el of allDeep()) {
      const r = el.getBoundingClientRect();
      if (r.left < 200 || r.width <= 0) continue;
      const t = normalizeTimeTitle(el.value || el.innerText || "");
      if (t && (t.includes(normExpected) || normExpected.includes(t))) return true;
    }
    return false;
  }

  // Polls (no fixed sleeps) until the Transcript view shows THIS recording's text, then returns it.
  // Guards against the previous recording's transcript still being on screen.
  async function readTranscriptFast(title, prevText) {
    const norm = normalizeTimeTitle(title || "");
    const start = Date.now();
    let lastText = null;
    let reclicked = false;
    while (Date.now() - start < 15000 && !jobCancel) {
      const elapsed = Date.now() - start;
      const btn = findTranscriptButton();
      if (btn && btn.getAttribute("aria-checked") !== "true") btn.click();
      const box = btn && btn.getAttribute("aria-checked") === "true" ? findTranscriptContainer() : null;
      const titleOk = !norm || elapsed > 4000 || mainPanelHasTitle(norm);
      if (box && titleOk) {
        const text = deepText(box).trim();
        if (text && text !== prevText) {
          if (text === lastText) {
            console.log(`[Recorder][experimental] Extracted ${text.length} chars in ${elapsed}ms`);
            return text;
          }
          lastText = text;
        } else {
          lastText = null;
        }
      }
      if (!reclicked && norm && elapsed > 1500 && !titleOk) {
        reclicked = true;
        const itemEl = findVisibleSidebarItem(title, "");
        if (itemEl) await doClickItem(itemEl, true);
      }
      await sleep(60);
    }
    throw new Error(
      lastText === null ? "Transcript text was empty or did not update" : "Transcript did not stabilise"
    );
  }

  function waitIfPaused() {
    if (!jobPaused) return Promise.resolve();
    return new Promise((resolve) => {
      pauseResolver = resolve;
    });
  }

  function waitForContinue() {
    return new Promise((resolve) => {
      continueResolver = resolve;
    });
  }

  async function waitForToastToDisappear(timeoutMs = 25000) {
    const start = Date.now();
    await sleep(600);
    while (Date.now() - start < timeoutMs) {
      let toastFound = false;
      for (const el of allDeep()) {
        const text = (el.innerText || "").trim();
        if (text.includes("Downloading transcript") || text.includes("Downloading…")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            toastFound = true;
            break;
          }
        }
      }
      if (!toastFound) {
        await sleep(400);
        let recheck = false;
        for (const el of allDeep()) {
          const text = (el.innerText || "").trim();
          if (text.includes("Downloading transcript") || text.includes("Downloading…")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              recheck = true;
              break;
            }
          }
        }
        if (!recheck) return true;
      }
      await sleep(350);
    }
    return false;
  }

  async function downloadLoop(targets, options) {
    scrollSidebarToTop();
    await sleep(400);

    const results = [];
    let lastExperimentalText = null;
    for (let i = 0; i < targets.length; i++) {
      if (jobCancel) break;
      await waitIfPaused();
      if (jobCancel) break;

      const it = targets[i];
      const title = it.title || "recording";
      const created = it.created || "";
      const key = `${title}||${created}`;
      const suggestedName = options.names?.[key] || null;

      send({
        type: "item_start",
        index: i,
        total: targets.length,
        title,
        created,
        suggestedName,
      });

      if (!options.force && suggestedName && options.skipNames?.includes(suggestedName)) {
        console.log(`[Recorder] [${i + 1}/${targets.length}] Skipping existing: ${suggestedName}`);
        results.push({
          title,
          created,
          status: "skipped",
          filename: suggestedName,
        });
        send({
          type: "item_done",
          index: i,
          status: "skipped",
          title,
          created,
          filename: suggestedName,
        });
        continue;
      }

      console.log(`[Recorder] [${i + 1}/${targets.length}] Selecting sidebar item: "${title}" (${created})`);
      const opened = await clickSidebarItem(title, created, !!options.experimental);
      if (!opened) {
        console.warn(`[Recorder] [${i + 1}/${targets.length}] Failed to locate/click item in sidebar: "${title}"`);
        results.push({ title, created, status: "click_failed" });
        send({
          type: "item_done",
          index: i,
          status: "click_failed",
          title,
          created,
        });
        continue;
      }

      // Wait for player and Settings button to be ready for THIS specific recording
      if (!options.experimental) {
        await waitForRecordingReady(title);
        await sleep(500);
      }

      if (jobCancel) break;
      await waitIfPaused();
      if (jobCancel) break;

      if (options.experimental) {
        try {
          const text = await readTranscriptFast(title, lastExperimentalText);
          lastExperimentalText = text;
          const res = await sendAsync({
            action: "downloadTranscriptDirectly",
            filename: suggestedName || "transcript.txt",
            text,
          });
          if (!res?.ok) throw new Error(res?.error || "Could not save transcript file");
          results.push({ title, created, status: "ok", filename: suggestedName });
          send({ type: "item_done", index: i, status: "ok", title, created, filename: suggestedName });
        } catch (err) {
          console.error(`[Recorder][experimental] Failed "${title}":`, err);
          const error = String(err?.message || err);
          results.push({ title, created, status: "failed", error });
          send({ type: "item_done", index: i, status: "failed", title, created, error });
        }
        continue;
      }

      send({
        type: "expect_download",
        filename: suggestedName,
        title,
        created,
      });

      try {
        console.log(`[Recorder] [${i + 1}/${targets.length}] Triggering download format dialog for: "${title}"`);
        await downloadCurrentTxt(suggestedName);

        send({
          type: "status",
          message: `Downloading ${i + 1} / ${targets.length}: Waiting for file to generate…`,
        });

        // 1. Check if direct transcript was captured via hook
        let downloadedOk = false;
        const waitBlobStart = Date.now();
        while (Date.now() - waitBlobStart < 6000) {
          if (latestCapturedText) {
            console.log(`[Recorder] Direct transcript captured via hook (${latestCapturedText.length} chars)!`);
            const directRes = await sendAsync({
              action: "downloadTranscriptDirectly",
              filename: suggestedName,
              text: latestCapturedText,
            });
            if (directRes?.ok) {
              console.log(`[Recorder] Direct download succeeded (ID: ${directRes.downloadId})`);
              downloadedOk = true;
              break;
            }
          }
          await sleep(250);
        }

        // 2. If direct download wasn't triggered yet, wait for browser download start
        if (!downloadedOk) {
          console.log(`[Recorder] Waiting for Chrome download to start via background...`);
          const dlRes = await sendAsync({ action: "waitForDownloadStart", timeoutMs: 20000 });
          if (dlRes?.ok) {
            console.log(`[Recorder] Chrome confirmed download started (ID: ${dlRes.downloadId})`);
            downloadedOk = true;
          } else {
            console.warn(`[Recorder] Download start warning/timeout: ${dlRes?.error}`);
          }
        }

        if (!downloadedOk) {
          throw new Error(`Download did not start for "${title}" (timed out waiting for transcript file)`);
        }

        // 3. Wait for "Downloading transcript..." toast to clear
        send({
          type: "status",
          message: `Downloading ${i + 1} / ${targets.length}: Finishing transcript…`,
        });
        console.log(`[Recorder] Waiting for "Downloading transcript..." toast to clear...`);
        await waitForToastToDisappear(20000);
        console.log(`[Recorder] Toast cleared.`);

        // 4. Pacing delay cooldown before navigating away to next item
        const delaySec = Number.isFinite(Number(options.delaySeconds)) ? Number(options.delaySeconds) : 4;
        send({
          type: "status",
          message: `Downloading ${i + 1} / ${targets.length}: Pacing cooldown (${delaySec}s)…`,
        });
        console.log(`[Recorder] Cooling down for ${delaySec}s before next item...`);
        await sleep(delaySec * 1000);

        results.push({
          title,
          created,
          status: "ok",
          filename: suggestedName,
        });
        send({
          type: "item_done",
          index: i,
          status: "ok",
          title,
          created,
          filename: suggestedName,
        });
        console.log(`[Recorder] [${i + 1}/${targets.length}] Successfully downloaded: "${title}"`);
      } catch (err) {
        if (isModalOrMenuOpen()) {
          pressEscape();
        }
        // Flush unconsumed filenames from queue so manifest is never renamed
        sendAsync({ action: "clearExpectedDownloads" }).catch(() => {});

        console.error(`[Recorder] [${i + 1}/${targets.length}] Error processing "${title}":`, err);
        results.push({
          title,
          created,
          status: "failed",
          error: String(err?.message || err),
        });
        send({
          type: "item_done",
          index: i,
          status: "failed",
          title,
          created,
          error: String(err?.message || err),
        });
        await sleep(2000);
      }
    }
    return results;
  }

  async function runJob(options) {
    if (jobRunning) {
      console.warn("[Recorder] Previous job still running, stopping it before starting new run...");
      jobCancel = true;
      jobPaused = false;
      if (pauseResolver) pauseResolver();
      if (continueResolver) continueResolver();
      let waitCount = 0;
      while (jobRunning && waitCount < 15) {
        await sleep(100);
        waitCount++;
      }
    }
    jobRunning = true;
    jobCancel = false;
    jobPaused = false;
    pendingTargets = null;

    try {
      send({ type: "status", message: "Listing recordings (newest first, early-stop)…" });
      const { items: all, stopReason } = await listRecordings({
        startISO: options.startISO,
        endISO: options.endISO,
        labels: options.labels || [],
      });
      const targets = filterMatches(all, {
        startISO: options.startISO,
        endISO: options.endISO,
        labels: options.labels || [],
      });
      pendingTargets = targets;

      send({
        type: "listed",
        totalSidebar: all.length,
        matchCount: targets.length,
        matches: targets,
        stopReason,
      });

      if (options.dryRun) {
        send({
          type: "complete",
          dryRun: true,
          results: targets.map((t) => ({
            title: t.title,
            created: t.created,
            status: "matched",
          })),
        });
        return;
      }

      if (!targets.length) {
        send({ type: "complete", dryRun: false, results: [] });
        return;
      }

      if (options.waitForContinue) {
        const cont = await waitForContinue();
        if (jobCancel) {
          send({ type: "complete", dryRun: false, stopped: true, results: [] });
          return;
        }
        const results = await downloadLoop(targets, cont || options);
        send({ type: "complete", dryRun: false, stopped: jobCancel, results });
      } else {
        const results = await downloadLoop(targets, options);
        send({ type: "complete", dryRun: false, stopped: jobCancel, results });
      }
    } catch (err) {
      send({ type: "error", message: String(err?.message || err) });
    } finally {
      jobRunning = false;
      jobCancel = false;
      jobPaused = false;
      continueResolver = null;
      pauseResolver = null;
      pendingTargets = null;
    }
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage({ source: "recorder-content", ...msg });
    } catch {
      /* ignore */
    }
  }

  function sendAsync(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ source: "recorder-content", ...msg }, (res) => {
          resolve(res);
        });
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "recorder-content") return;

    if (msg.action === "ping") {
      sendResponse({ ok: true, url: location.href, running: jobRunning, paused: jobPaused });
      return true;
    }
    if (msg.action === "pause") {
      jobPaused = true;
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "resume") {
      jobPaused = false;
      if (pauseResolver) {
        pauseResolver();
        pauseResolver = null;
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "stop" || msg.action === "cancel") {
      jobCancel = true;
      jobPaused = false;
      if (pauseResolver) {
        pauseResolver();
        pauseResolver = null;
      }
      if (continueResolver) {
        continueResolver({ force: true, names: {}, skipNames: [] });
        continueResolver = null;
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "continue") {
      if (continueResolver) {
        continueResolver(msg.options || {});
        continueResolver = null;
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "not waiting" });
      }
      return true;
    }
    if (msg.action === "start") {
      runJob(msg.options || {})
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    return false;
  });

  send({ type: "content_ready", url: location.href });
})();
