/**
 * Service worker: tab targeting, download rename, job state, manifest export.
 */
import { daterangeLabels, sanitizeFilename } from "../lib/dates.js";

const STATE_KEY = "jobState";

const defaultState = () => ({
  status: "idle", // idle | listing | running | complete | error
  message: "",
  dryRun: false,
  force: false,
  exportManifest: true,
  experimental: false,
  start: null,
  end: null,
  labels: [],
  total: 0,
  index: 0,
  matches: [],
  results: [],
  listPasses: [],
  lastError: null,
  tabId: null,
  updatedAt: Date.now(),
});

async function getState() {
  const data = await chrome.storage.session.get(STATE_KEY);
  return data[STATE_KEY] || defaultState();
}

async function setState(patch) {
  const prev = await getState();
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ [STATE_KEY]: next });
  try {
    chrome.runtime
      .sendMessage({ source: "recorder-sw", type: "state", state: next })
      .catch(() => {}); // popup closed: no receiver
  } catch {
    /* no listeners */
  }
  return next;
}

// ---- Automatic downloads permission helper ----
async function allowAutomaticDownloads() {
  try {
    if (chrome.contentSettings?.automaticDownloads) {
      await chrome.contentSettings.automaticDownloads.set({
        primaryPattern: "https://recorder.google.com/*",
        setting: "allow",
      });
      console.log("[SW] automaticDownloads set to allow for recorder.google.com");
    }
  } catch (err) {
    console.warn("[SW] Could not configure automaticDownloads:", err);
  }
}
allowAutomaticDownloads();

// ---- Download tracking & filename control (FIFO queue) ----
const expectedFilenames = [];
const directDownloadNames = new Map(); // data: URL -> filename
const downloadWaiters = [];
let lastDownloadCreated = 0;
let lastDownloadItem = null;

chrome.downloads.onCreated.addListener((item) => {
  console.log("[SW] chrome.downloads.onCreated:", item.id, item.url || "");
  lastDownloadCreated = Date.now();
  lastDownloadItem = item;
  if (downloadWaiters.length > 0) {
    const waiter = downloadWaiters.shift();
    waiter(item);
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state) {
    console.log(`[SW] Download ${delta.id} state:`, delta.state.current);
  }
  if (delta.error) {
    console.warn(`[SW] Download ${delta.id} error:`, delta.error.current);
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Transcript data: URLs get their name from directDownloadNames (Chrome would otherwise say download.txt)
  if (item.url && directDownloadNames.has(item.url)) {
    const fn = directDownloadNames.get(item.url);
    directDownloadNames.delete(item.url);
    suggest({ filename: fn, conflictAction: "uniquify" });
    return;
  }
  // Never rename other data: URL downloads (like manifest JSON exports)
  if (item.url && item.url.startsWith("data:")) {
    return false;
  }
  if (expectedFilenames.length > 0) {
    const fn = expectedFilenames.shift();
    console.log("[SW] onDeterminingFilename renaming to:", fn);
    suggest({ filename: fn, conflictAction: "uniquify" });
    return; // Synchronous suggest MUST NOT return true in Chrome MV3
  }
  return false;
});

async function findRecorderTab() {
  const tabs = await chrome.tabs.query({ url: "https://recorder.google.com/*" });
  if (!tabs.length) return null;
  const detail = tabs.find((t) =>
    /recorder\.google\.com\/[0-9a-f-]{20,}/i.test(t.url || "")
  );
  return detail || tabs[0];
}

async function ensureRecorderTab() {
  let tab = await findRecorderTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* ignore */
      }
    }
    return tab;
  }
  tab = await chrome.tabs.create({ url: "https://recorder.google.com/", active: true });
  await waitTabComplete(tab.id);
  return tab;
}

function waitTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return resolve(t);
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("Recorder tab load timeout"));
      }
      setTimeout(check, 300);
    };
    check();
  });
}

async function injectMainHook(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (window.__recorderHookInstalled) return;
        window.__recorderHookInstalled = true;

        const origCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function (obj) {
          const url = origCreateObjectURL.call(this, obj);
          try {
            if (obj instanceof Blob) {
              if (!obj.type || obj.type.includes("text") || obj.type.includes("plain")) {
                obj.text().then((text) => {
                  window.postMessage(
                    {
                      source: "recorder-main-interceptor",
                      type: "blob_created",
                      url,
                      text,
                      size: obj.size,
                    },
                    "*"
                  );
                }).catch(() => {});
              }
            }
          } catch (e) {}
          return url;
        };

        const origAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          try {
            if (this.download || (this.href && (this.href.startsWith("blob:") || this.href.startsWith("data:")))) {
              window.postMessage(
                {
                  source: "recorder-main-interceptor",
                  type: "anchor_click",
                  download: this.download,
                  href: this.href,
                },
                "*"
              );
            }
          } catch (e) {}
          return origAnchorClick.apply(this, arguments);
        };
        console.log("[Recorder SW] Main world hook successfully installed!");
      },
    });
  } catch (err) {
    console.warn("[SW] Could not inject main world hook:", err);
  }
}

async function injectContent(tabId) {
  await injectMainHook(tabId);
  try {
    const res = await chrome.tabs.sendMessage(tabId, {
      target: "recorder-content",
      action: "ping",
    });
    if (res?.ok) return;
  } catch {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/content.js"],
  });
  await new Promise((r) => setTimeout(r, 250));
}

async function searchExistingTxtNames(names) {
  const existing = new Set();
  for (const name of names) {
    if (!name) continue;
    try {
      const found = await chrome.downloads.search({
        filenameRegex: `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        limit: 5,
      });
      if (found?.some((f) => f.exists !== false && f.state === "complete")) {
        existing.add(name);
        continue;
      }
    } catch {
      /* fall through */
    }
    try {
      const found = await chrome.downloads.search({ query: [name], limit: 25 });
      if (
        found?.some(
          (f) =>
            f.state === "complete" &&
            (f.filename || "").replace(/\\/g, "/").endsWith(name) &&
            f.exists !== false
        )
      ) {
        existing.add(name);
      }
    } catch {
      /* ignore */
    }
  }
  return [...existing];
}

async function startJob(options) {
  const { start, end, dryRun, force, exportManifest, experimental, delaySeconds } = options;
  let labels;
  try {
    labels = daterangeLabels(start, end);
  } catch (e) {
    await setState({
      status: "error",
      lastError: e.message,
      message: e.message,
    });
    throw e;
  }

  await allowAutomaticDownloads();
  expectedFilenames.length = 0;
  chrome.alarms.create("job-keepalive", { delayInMinutes: 0.4 });

  await setState({
    ...defaultState(),
    status: "listing",
    message: "Preparing Recorder tab…",
    dryRun: !!dryRun,
    force: !!force,
    exportManifest: exportManifest !== false,
    experimental: !!experimental,
    delaySeconds: Number.isFinite(Number(delaySeconds)) ? Number(delaySeconds) : 4,
    start,
    end,
    labels,
  });

  const tab = await ensureRecorderTab();
  try {
    await waitTabComplete(tab.id);
  } catch {
    /* may already be complete */
  }
  // Small wait for SPA shell
  await new Promise((r) => setTimeout(r, 800));
  await injectContent(tab.id);

  await setState({
    status: "listing",
    message: "Listing recordings…",
    tabId: tab.id,
  });

  await chrome.tabs.sendMessage(tab.id, {
    target: "recorder-content",
    action: "start",
    options: {
      labels,
      startISO: start,
      endISO: end,
      dryRun: !!dryRun,
      force: !!force,
      experimental: !!experimental,
      delaySeconds: Number.isFinite(Number(delaySeconds)) ? Number(delaySeconds) : 4,
      waitForContinue: !dryRun,
      names: {},
      skipNames: [],
    },
  });
}

async function continueAfterList(matches) {
  const state = await getState();
  const names = {};
  for (const m of matches) {
    const key = `${m.title}||${m.created}`;
    names[key] = sanitizeFilename(m.title, m.created);
  }
  let skipNames = [];
  if (!state.force) {
    skipNames = await searchExistingTxtNames(Object.values(names));
  }

  await setState({
    status: "running",
    message:
      matches.length === 0
        ? "No matching recordings"
        : `Downloading 0 / ${matches.length}`,
    matches,
    total: matches.length,
    index: 0,
    names,
    skipNames,
  });

  if (matches.length === 0) {
    await setState({
      status: "complete",
      results: [],
      message: "No matching recordings in that date range",
    });
    if (state.exportManifest !== false) {
      await exportManifestFile(await getState());
    }
    return;
  }

  if (state.tabId != null) {
    await chrome.tabs.sendMessage(state.tabId, {
      target: "recorder-content",
      action: "continue",
      options: {
        force: !!state.force,
        experimental: !!state.experimental,
        names,
        skipNames,
        delaySeconds: state.delaySeconds ?? 4,
      },
    });
  }
}

async function exportManifestFile(state) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    start: state.start,
    end: state.end,
    dryRun: state.dryRun,
    force: state.force,
    labels: state.labels || [],
    matchCount: (state.matches || []).length,
    results: state.results || [],
    matches: state.matches || [],
  };
  const text = JSON.stringify(manifest, null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
  const filename = `recorder-transcripts_manifest_${state.start || "na"}_${state.end || "na"}.json`;
  await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.source === "recorder-popup") {
    (async () => {
      try {
        if (msg.action === "getState") {
          sendResponse({ ok: true, state: await getState() });
          return;
        }
        if (msg.action === "start") {
          await startJob(msg.options || {});
          sendResponse({ ok: true });
          return;
        }
        if (msg.action === "pause") {
          const state = await getState();
          if (state.tabId != null) {
            try {
              await chrome.tabs.sendMessage(state.tabId, {
                target: "recorder-content",
                action: "pause",
              });
            } catch {
              /* ignore */
            }
          }
          await setState({ status: "paused", message: "Job paused" });
          sendResponse({ ok: true });
          return;
        }
        if (msg.action === "resume") {
          const state = await getState();
          if (state.tabId != null) {
            try {
              await chrome.tabs.sendMessage(state.tabId, {
                target: "recorder-content",
                action: "resume",
              });
            } catch {
              /* ignore */
            }
          }
          await setState({ status: "running", message: "Resuming downloads…" });
          sendResponse({ ok: true });
          return;
        }
        if (msg.action === "stop" || msg.action === "cancel") {
          const state = await getState();
          if (state.tabId != null) {
            try {
              await chrome.tabs.sendMessage(state.tabId, {
                target: "recorder-content",
                action: "stop",
              });
            } catch {
              /* ignore */
            }
          }
          await setState({ status: "stopped", message: "Stopping job…" });
          sendResponse({ ok: true });
          return;
        }
        if (msg.action === "ensureTab") {
          const tab = await ensureRecorderTab();
          sendResponse({ ok: true, tabId: tab.id, url: tab.url });
          return;
        }
        if (msg.action === "exportManifest") {
          await exportManifestFile(await getState());
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, error: "unknown action" });
      } catch (e) {
        const message = String(e.message || e);
        await setState({ status: "error", lastError: message, message });
        sendResponse({ ok: false, error: message });
      }
    })();
    return true;
  }

  if (msg.source === "recorder-content") {
    if (msg.action === "waitForDownloadStart") {
      if (Date.now() - lastDownloadCreated < 2500 && lastDownloadItem) {
        const item = lastDownloadItem;
        lastDownloadItem = null;
        console.log("[SW] waitForDownloadStart matched recent download:", item.id);
        sendResponse({ ok: true, downloadId: item.id });
        return true;
      }
      const timeoutMs = msg.timeoutMs || 25000;
      let timer;
      const waiter = (downloadItem) => {
        clearTimeout(timer);
        console.log("[SW] waitForDownloadStart resolved via onCreated:", downloadItem?.id);
        sendResponse({ ok: true, downloadId: downloadItem?.id });
      };
      timer = setTimeout(() => {
        const idx = downloadWaiters.indexOf(waiter);
        if (idx !== -1) downloadWaiters.splice(idx, 1);
        if (expectedFilenames.length > 0) {
          const dropped = expectedFilenames.shift();
          console.warn("[SW] Timeout: dropped unconsumed expected filename:", dropped);
        }
        console.warn(`[SW] waitForDownloadStart timed out after ${Math.round(timeoutMs / 1000)}s`);
        sendResponse({ ok: false, error: `Download did not start within ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      downloadWaiters.push(waiter);
      return true;
    }

    if (msg.action === "downloadTranscriptDirectly") {
      (async () => {
        try {
          const text = msg.text || "";
          const filename = msg.filename || "transcript.txt";
          const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
          directDownloadNames.set(dataUrl, filename);
          const id = await chrome.downloads.download({
            url: dataUrl,
            filename,
            conflictAction: "uniquify",
            saveAs: false,
          });
          console.log("[SW] downloadTranscriptDirectly succeeded (ID:", id, ") for:", filename);
          sendResponse({ ok: true, downloadId: id });
        } catch (err) {
          directDownloadNames.delete(`data:text/plain;charset=utf-8,${encodeURIComponent(msg.text || "")}`);
          console.error("[SW] downloadTranscriptDirectly error:", err);
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }

    if (msg.action === "clearExpectedDownloads") {
      expectedFilenames.length = 0;
      sendResponse({ ok: true });
      return true;
    }

    (async () => {
      const state = await getState();
      switch (msg.type) {
        case "list_progress": {
          let message = `Listing… pass ${msg.attempt} (${msg.count} items)`;
          if (typeof msg.matchCount === "number") {
            message += ` · ${msg.matchCount} in range`;
          }
          if (msg.pastRangeStart) {
            message += " · past range, stopping";
          }
          if (msg.stopReason === "past_range_start") {
            message = `List done early (passed date range) · ${msg.count} scanned`;
          } else if (msg.stopReason === "list_exhausted") {
            message = `List exhausted · ${msg.count} items`;
          }
          await setState({
            message,
            listPasses: [...(state.listPasses || []).slice(-20), msg],
          });
          break;
        }

        case "listed":
          await setState({
            matches: msg.matches || [],
            total: msg.matchCount || 0,
            message: `Found ${msg.matchCount} match(es) after scanning ${msg.totalSidebar} (stop: ${msg.stopReason || "n/a"})`,
          });
          if (state.dryRun) {
            // Wait for content "complete" for final status + optional manifest
            break;
          }
          await continueAfterList(msg.matches || []);
          break;

        case "expect_download":
          if (msg.filename) {
            expectedFilenames.push(msg.filename);
          }
          break;

        case "item_start":
          await setState({
            status: "running",
            index: msg.index,
            total: msg.total,
            message: `Downloading ${msg.index + 1} / ${msg.total}: ${msg.title}`,
          });
          break;

        case "item_done": {
          const results = [
            ...(state.results || []),
            {
              title: msg.title,
              created: msg.created,
              status: msg.status,
              filename: msg.filename,
              error: msg.error,
            },
          ];
          await setState({
            results,
            index: (msg.index ?? 0) + 1,
            message: `${msg.status}: ${msg.title}`,
          });
          break;
        }

        case "complete": {
          let results = msg.results || state.results || [];
          if (msg.dryRun && !results.length && (state.matches || []).length) {
            results = (state.matches || []).map((t) => ({
              title: t.title,
              created: t.created,
              status: "matched",
              filename: sanitizeFilename(t.title, t.created),
            }));
          }
          const ok = results.filter((r) => r.status === "ok").length;
          const skipped = results.filter((r) => r.status === "skipped").length;
          const failed = results.filter(
            (r) => r.status === "failed" || r.status === "click_failed"
          ).length;
          const matched = results.filter((r) => r.status === "matched").length;
          const finalStatus = msg.stopped ? "stopped" : "complete";
          const finalMsg = msg.stopped
            ? `Stopped: ${ok} downloaded · ${skipped} skipped · ${failed} failed`
            : msg.dryRun
              ? `Dry-run complete: ${matched || results.length} match(es)`
              : `Done: ${ok} downloaded · ${skipped} skipped · ${failed} failed`;

          await setState({
            status: finalStatus,
            results,
            message: finalMsg,
          });
          const s = await getState();
          if (s.exportManifest !== false && results.length > 0) {
            await exportManifestFile(s);
          }
        }

        case "error":
          await setState({
            status: "error",
            lastError: msg.message,
            message: msg.message,
            results: msg.results || state.results,
          });
          break;

        case "status":
          await setState({ message: msg.message });
          break;

        default:
          break;
      }
    })();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "job-keepalive") return;
  getState().then((s) => {
    if (s.status === "running" || s.status === "listing") {
      chrome.alarms.create("job-keepalive", { delayInMinutes: 0.4 });
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ [STATE_KEY]: defaultState() });
});
