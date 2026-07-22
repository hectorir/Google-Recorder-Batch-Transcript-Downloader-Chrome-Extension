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

  async function listRecordings() {
    let items = [];
    let stable = 0;
    let prevCount = -1;

    for (let attempt = 0; attempt < 25; attempt++) {
      if (jobCancel) throw new Error("Cancelled");

      let clicked = false;
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
          clicked = true;
          break;
        }
      }
      if (clicked) await sleep(1400);

      for (const el of allDeep()) {
        if (
          el.scrollHeight > el.clientHeight + 50 &&
          el.clientWidth < 420 &&
          el.clientWidth > 180
        ) {
          el.scrollTop = el.scrollHeight;
        }
      }
      await sleep(700);

      items = [];
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

      send({
        type: "list_progress",
        attempt: attempt + 1,
        count: items.length,
        loadMore: clicked,
      });

      if (items.length === prevCount && !clicked) stable += 1;
      else stable = 0;
      prevCount = items.length;
      if (stable >= 2) break;
    }

    const seen = new Set();
    const unique = [];
    for (const it of items) {
      const key = `${it.title}||${it.created}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(it);
    }
    return unique;
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

    const labels = new Set(options.labels || []);

    try {
      send({ type: "status", message: "Listing recordings…" });
      const all = await listRecordings();
      const targets = all.filter((it) => labels.has(it.created));
      pendingTargets = targets;

      send({
        type: "listed",
        totalSidebar: all.length,
        matchCount: targets.length,
        matches: targets,
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
