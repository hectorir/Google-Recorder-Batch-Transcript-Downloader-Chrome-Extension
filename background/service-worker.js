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
    chrome.runtime.sendMessage({ source: "recorder-sw", type: "state", state: next });
  } catch {
    /* no listeners */
  }
  return next;
}

// ---- Download filename control ----
let expectedFilename = null;

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!expectedFilename) return false;
  // Recorder may download as UUID without extension or as .txt
  suggest({ filename: expectedFilename, conflictAction: "uniquify" });
  expectedFilename = null;
  return true;
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

async function injectContent(tabId) {
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
  const { start, end, dryRun, force, exportManifest } = options;
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

  chrome.alarms.create("job-keepalive", { delayInMinutes: 0.4 });

  await setState({
    ...defaultState(),
    status: "listing",
    message: "Preparing Recorder tab…",
    dryRun: !!dryRun,
    force: !!force,
    exportManifest: exportManifest !== false,
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
      dryRun: !!dryRun,
      force: !!force,
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
        names,
        skipNames,
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
        if (msg.action === "cancel") {
          const state = await getState();
          if (state.tabId != null) {
            try {
              await chrome.tabs.sendMessage(state.tabId, {
                target: "recorder-content",
                action: "cancel",
              });
            } catch {
              /* ignore */
            }
          }
          await setState({ status: "idle", message: "Cancelled" });
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
    (async () => {
      const state = await getState();
      switch (msg.type) {
        case "list_progress":
          await setState({
            message: `Listing… pass ${msg.attempt} (${msg.count} items)`,
            listPasses: [...(state.listPasses || []).slice(-20), msg],
          });
          break;

        case "listed":
          await setState({
            matches: msg.matches || [],
            total: msg.matchCount || 0,
            message: `Found ${msg.matchCount} match(es) of ${msg.totalSidebar} recordings`,
          });
          if (state.dryRun) {
            // Wait for content "complete" for final status + optional manifest
            break;
          }
          await continueAfterList(msg.matches || []);
          break;

        case "expect_download":
          expectedFilename = msg.filename || null;
          break;

        case "item_start":
          await setState({
            status: "running",
            index: msg.index,
            total: msg.total,
            message: `Downloading ${msg.index + 1} / ${msg.total}: ${msg.title}`,
          });
          if (msg.suggestedName) expectedFilename = msg.suggestedName;
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
          await setState({
            status: "complete",
            results,
            message: msg.dryRun
              ? `Dry-run complete: ${matched || results.length} match(es)`
              : `Done: ${ok} downloaded · ${skipped} skipped · ${failed} failed`,
          });
          const s = await getState();
          if (s.exportManifest !== false) {
            await exportManifestFile(s);
          }
          break;
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
