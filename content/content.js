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

  /** Parse "2026 Jul 17" → local midnight Date, or null. */
  function parseRecorderLabel(label) {
    if (!label) return null;
    const m = /(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})/.exec(String(label).trim());
    if (!m) return null;
    const mon = MONTHS[m[2].slice(0, 3)];
    if (!mon) return null;
    const d = new Date(Number(m[1]), mon - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
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

  function scrollSidebarDown() {
    for (const el of allDeep()) {
      if (
        el.scrollHeight > el.clientHeight + 50 &&
        el.clientWidth < 420 &&
        el.clientWidth > 180
      ) {
        el.scrollTop = el.scrollHeight;
      }
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

  async function clickSidebarItem(title, created) {
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
      let t = "";
      let c = "";
      for (const d of allDeep(el)) {
        const a = d.getAttribute?.("aria-label") || "";
        if (a.startsWith("Created on ")) c = a.replace("Created on ", "").trim();
        if (d.classList && d.classList.contains("title")) t = (d.innerText || "").trim();
      }
      if (!t) {
        const cont = allDeep(el).find(
          (x) => x.classList && x.classList.contains("container")
        );
        if (cont) t = (cont.innerText || "").trim().split("\n")[0].trim();
      }
      if (t === title && c === created) {
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      }
    }
    return false;
  }

  async function downloadCurrentTxt() {
    pressEscape();
    await sleep(300);

    let settings = null;
    for (const el of allDeep()) {
      if (el.getAttribute?.("aria-label") === "Settings" && el.tagName === "BUTTON") {
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          settings = el;
          break;
        }
      }
    }
    if (!settings) throw new Error("Settings (⋮) button not found");
    settings.click();
    await sleep(800);

    const menuCandidates = [];
    for (const el of allDeep()) {
      const t = (el.innerText || "").trim();
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (t !== "Download") continue;
      const role = el.getAttribute?.("role") || "";
      const score =
        (role === "menuitem" ? 100 : 0) + (el.tagName.includes("LIST-ITEM") ? 50 : 0);
      menuCandidates.push({ el, score });
    }
    menuCandidates.sort((a, b) => b.score - a.score);
    if (!menuCandidates.length) throw new Error("Download menu item not found");
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

    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = [];
      for (const el of allDeep()) {
        if (el.tagName !== "MWC-CHECK-LIST-ITEM") continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0) continue;
        const text = (el.innerText || "").trim();
        const on = el.getAttribute("aria-checked") === "true" || !!el.selected;
        rows.push({ el, text, on });
      }
      const audio = rows.find((x) => /Audio file/i.test(x.text));
      const textRow = rows.find((x) => /Text file/i.test(x.text));
      if (textRow?.on && !audio?.on) break;
      if (audio?.on) audio.el.click();
      if (textRow && !textRow.on) textRow.el.click();
      await sleep(350);
    }

    for (const el of allDeep()) {
      if (el.tagName !== "MWC-CHECK-LIST-ITEM") continue;
      if (!/Text file/i.test(el.innerText || "")) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      if (el.getAttribute("aria-checked") !== "true" && !el.selected) el.click();
    }
    await sleep(300);

    const dlCandidates = [];
    for (const el of allDeep()) {
      const t = (el.innerText || "").trim();
      if (t !== "Download") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const role = el.getAttribute?.("role") || "";
      if (role === "menuitem") continue;
      const score =
        (el.tagName === "BUTTON" || el.tagName === "MWC-BUTTON" ? 100 : 0) + r.y;
      dlCandidates.push({ el, score });
    }
    dlCandidates.sort((a, b) => b.score - a.score);
    if (!dlCandidates.length) throw new Error("Dialog Download button not found");
    dlCandidates[0].el.click();
    await sleep(800);
    pressEscape();
    return true;
  }

  let jobCancel = false;
  let jobRunning = false;
  let pendingTargets = null;
  let continueResolver = null;

  function waitForContinue() {
    return new Promise((resolve) => {
      continueResolver = resolve;
    });
  }

  async function downloadLoop(targets, options) {
    const results = [];
    for (let i = 0; i < targets.length; i++) {
      if (jobCancel) throw new Error("Cancelled");
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

      const opened = await clickSidebarItem(title, created);
      if (!opened) {
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
      await sleep(1500);

      send({
        type: "expect_download",
        filename: suggestedName,
        title,
        created,
      });

      try {
        await downloadCurrentTxt();
        await sleep(1400);
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
      } catch (err) {
        pressEscape();
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
        await sleep(500);
      }
    }
    return results;
  }

  async function runJob(options) {
    if (jobRunning) throw new Error("A job is already running in this tab");
    jobRunning = true;
    jobCancel = false;
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
        if (jobCancel) throw new Error("Cancelled");
        const results = await downloadLoop(targets, cont || options);
        send({ type: "complete", dryRun: false, results });
      } else {
        const results = await downloadLoop(targets, options);
        send({ type: "complete", dryRun: false, results });
      }
    } catch (err) {
      send({ type: "error", message: String(err?.message || err) });
    } finally {
      jobRunning = false;
      jobCancel = false;
      continueResolver = null;
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "recorder-content") return;

    if (msg.action === "ping") {
      sendResponse({ ok: true, url: location.href, running: jobRunning });
      return true;
    }
    if (msg.action === "cancel") {
      jobCancel = true;
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
