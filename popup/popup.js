import { presetRange, toISODate } from "../lib/dates.js";

const $ = (id) => document.getElementById(id);

const els = {
  startDate: $("startDate"),
  endDate: $("endDate"),
  dryRun: $("dryRun"),
  force: $("force"),
  exportManifest: $("exportManifest"),
  experimental: $("experimental"),
  delaySeconds: $("delaySeconds"),
  btnOpen: $("btnOpen"),
  btnStart: $("btnStart"),
  btnPause: $("btnPause"),
  btnStop: $("btnStop"),
  btnManifest: $("btnManifest"),
  statusPill: $("statusPill"),
  statusMessage: $("statusMessage"),
  progressMeta: $("progressMeta"),
  barFill: $("barFill"),
  resultList: $("resultList"),
  presets: $("presets"),
  actions: document.querySelector(".actions"),
};

function todayISO() {
  return toISODate(new Date());
}

function setDates(start, end) {
  els.startDate.value = start;
  els.endDate.value = end;
}

function setActivePreset(name) {
  for (const btn of els.presets.querySelectorAll(".chip")) {
    btn.classList.toggle("active", btn.dataset.preset === name);
  }
}

function loadDefaults() {
  const p = presetRange("last7");
  setDates(p.start, p.end);
  setActivePreset("last7");
}

els.presets.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  const p = presetRange(btn.dataset.preset);
  setDates(p.start, p.end);
  setActivePreset(btn.dataset.preset);
});

els.startDate.addEventListener("change", () => setActivePreset(null));
els.endDate.addEventListener("change", () => setActivePreset(null));

function send(action, payload = {}) {
  return chrome.runtime.sendMessage({
    source: "recorder-popup",
    action,
    ...payload,
  });
}

function renderState(state) {
  if (!state) return;
  const status = state.status || "idle";
  els.statusPill.textContent = status;
  els.statusPill.className = `pill ${status}`;

  els.statusMessage.textContent =
    state.message ||
    (status === "idle" ? "Set a date range and press Start." : "");

  const total = state.total || 0;
  const index = state.index || 0;
  const results = state.results || [];

  if (status === "listing") {
    els.progressMeta.textContent = "Listing…";
    els.barFill.style.width = "15%";
  } else if (status === "running" && total > 0) {
    const pct = Math.min(100, Math.round((index / total) * 100));
    els.progressMeta.textContent = `${Math.min(index, total)} / ${total}`;
    els.barFill.style.width = `${pct}%`;
  } else if (status === "complete") {
    els.progressMeta.textContent = `${results.length} item(s)`;
    els.barFill.style.width = "100%";
  } else if (status === "error") {
    els.progressMeta.textContent = "Error";
    els.barFill.style.width = "100%";
    els.barFill.style.background = "var(--danger)";
  } else {
    els.progressMeta.textContent = "—";
    els.barFill.style.width = "0%";
    els.barFill.style.background = "";
  }

  // Prefer results; on dry-run complete fall back to matches
  let render = results;
  if (
    !render.length &&
    status === "complete" &&
    (state.matches || []).length
  ) {
    render = (state.matches || []).map((m) => ({
      title: m.title,
      created: m.created,
      status: state.dryRun ? "matched" : "matched",
      filename: null,
    }));
  }

  els.resultList.innerHTML = render
    .map((r) => {
      const st = r.status || "—";
      const title = escapeHtml(r.title || "recording");
      const created = escapeHtml(r.created || "");
      const fn = r.filename ? escapeHtml(r.filename) : created;
      return `<li>
        <span class="st ${st}">${escapeHtml(st)}</span>
        <span class="meta">${title}<small>${fn}</small></span>
      </li>`;
    })
    .join("");

  const busy = status === "listing" || status === "running" || status === "paused";
  const isRunning = status === "running";
  const isPaused = status === "paused";

  els.btnStart.disabled = busy;
  els.btnOpen.disabled = busy;

  // Pause / Resume toggle button
  if (isRunning) {
    els.btnPause.classList.remove("hidden");
    els.btnPause.textContent = "Pause";
  } else if (isPaused) {
    els.btnPause.classList.remove("hidden");
    els.btnPause.textContent = "Resume";
  } else {
    els.btnPause.classList.add("hidden");
  }

  // Stop button
  els.btnStop.classList.toggle("hidden", !busy);
  els.actions.classList.toggle("is-busy", busy);
  els.actions.classList.toggle("has-cancel", busy);

  els.btnManifest.disabled = !(state.results || []).length && !(state.matches || []).length;
  els.dryRun.disabled = busy;
  els.force.disabled = busy;
  els.exportManifest.disabled = busy;
  els.experimental.disabled = busy;
  els.delaySeconds.disabled = busy;
  els.startDate.disabled = busy;
  els.endDate.disabled = busy;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refresh() {
  try {
    const res = await send("getState");
    if (res?.state) renderState(res.state);
  } catch {
    /* ignore */
  }
}

els.btnOpen.addEventListener("click", async () => {
  els.btnOpen.disabled = true;
  try {
    await send("ensureTab");
  } finally {
    els.btnOpen.disabled = false;
  }
});

els.btnStart.addEventListener("click", async () => {
  const start = els.startDate.value;
  const end = els.endDate.value;
  if (!start || !end) {
    els.statusMessage.textContent = "Choose start and end dates.";
    return;
  }
  if (end < start) {
    els.statusMessage.textContent = "End date must be on or after start date.";
    return;
  }

  els.barFill.style.background = "";
  els.resultList.innerHTML = "";

  const res = await send("start", {
    options: {
      start,
      end,
      dryRun: els.dryRun.checked,
      force: els.force.checked,
      exportManifest: els.exportManifest.checked,
      experimental: els.experimental.checked,
      delaySeconds: Number.isFinite(Number(els.delaySeconds.value)) ? Number(els.delaySeconds.value) : 4,
    },
  });
  if (!res?.ok) {
    els.statusMessage.textContent = res?.error || "Failed to start";
    els.statusPill.textContent = "error";
    els.statusPill.className = "pill error";
  }
  await refresh();
});

els.btnPause.addEventListener("click", async () => {
  const isPaused = els.statusPill.textContent.toLowerCase() === "paused";
  if (isPaused) {
    await send("resume");
  } else {
    await send("pause");
  }
  await refresh();
});

els.btnStop.addEventListener("click", async () => {
  await send("stop");
  await refresh();
});

els.btnManifest.addEventListener("click", async () => {
  await send("exportManifest");
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.source === "recorder-sw" && msg.type === "state") {
    renderState(msg.state);
  }
});

// Persist option toggles lightly
async function restoreOptions() {
  const data = await chrome.storage.local.get([
    "optDryRun",
    "optForce",
    "optManifest",
    "optExperimental",
    "optDelay",
    "optStart",
    "optEnd",
  ]);
  if (typeof data.optDryRun === "boolean") els.dryRun.checked = data.optDryRun;
  if (typeof data.optForce === "boolean") els.force.checked = data.optForce;
  if (typeof data.optManifest === "boolean") els.exportManifest.checked = data.optManifest;
  if (typeof data.optExperimental === "boolean") els.experimental.checked = data.optExperimental;
  if (data.optDelay) els.delaySeconds.value = data.optDelay;
  if (data.optStart && data.optEnd) {
    setDates(data.optStart, data.optEnd);
    setActivePreset(null);
  } else {
    loadDefaults();
  }
}

function persistOptions() {
  chrome.storage.local.set({
    optDryRun: els.dryRun.checked,
    optForce: els.force.checked,
    optManifest: els.exportManifest.checked,
    optExperimental: els.experimental.checked,
    optDelay: els.delaySeconds.value,
    optStart: els.startDate.value,
    optEnd: els.endDate.value,
  });
}

for (const el of [els.dryRun, els.force, els.exportManifest, els.experimental, els.delaySeconds, els.startDate, els.endDate]) {
  el.addEventListener("change", persistOptions);
}

restoreOptions().then(refresh);
setInterval(refresh, 1500);
