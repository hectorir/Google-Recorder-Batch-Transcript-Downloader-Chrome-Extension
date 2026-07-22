# Debug checklist — top 10 things to verify

Use this after loading the unpacked extension and running against a real `recorder.google.com` library.

---

### 1. Early-stop listing (date-sorted sidebar)
- [ ] **Today-only** (or a single recent day): listing should stop soon after older days appear — not scroll through hundreds of recordings.
- [ ] Progress text should mention **“past range, stopping”** / `stop: past_range_start` when applicable.
- [ ] Dry-run match count should equal the sessions you can see for that day in the UI.

### 2. Multi-day range still loads enough history
- [ ] Range like **last 7 days** or an older window (e.g. only last week’s mid-week) still scrolls/loads until the oldest visible date is **before** the range start.
- [ ] Matches for the **oldest day in the range** are not missing (early-stop must not cut off mid-range).

### 3. Match filter vs “Created on” labels
- [ ] Matches use **Created on** dates, not title text (“Jul 17 …” in the title alone does not include/exclude).
- [ ] Timezone edge: a session created “late night” still groups under Recorder’s **Created on** day (whatever Google shows).

### 4. Dry-run vs real download
- [ ] **Dry-run** lists matches only — no `.txt` files, no format dialog spam.
- [ ] With dry-run off, each match opens → ⋮ → Download → **Text file (.txt)** only (audio unchecked).

### 5. Download filenames & Downloads folder
- [ ] Files appear under Chrome **Downloads** as `YYYY-MM-DD_Sanitized-Title.txt`.
- [ ] `chrome.downloads.onDeterminingFilename` rename works (not stuck as UUID names).
- [ ] Collisions get uniquified (`(1)`, etc.) rather than overwriting silently.

### 6. Skip existing vs Force
- [ ] Second run **without Force** skips names already present in download history.
- [ ] **Force** re-downloads those same names.
- [ ] Skip is best-effort only (moved/renamed files may download again).

### 7. Tab targeting & injection
- [ ] With no Recorder tab open, **Start** / **Open Recorder** opens `recorder.google.com`.
- [ ] With a tab already open, that tab is focused and used.
- [ ] Signed-out state fails clearly (empty list / no items) rather than hanging forever.

### 8. Job lifecycle & Cancel
- [ ] Closing the popup mid-job does not kill listing/downloads (session state).
- [ ] Re-opening the popup shows current progress.
- [ ] **Cancel** stops further downloads; partial results remain visible.

### 9. Manifest export
- [ ] With **Export manifest** on, a JSON summary downloads at the end (dry-run and full).
- [ ] **Download manifest again** works after a completed job.
- [ ] Manifest `results` / `matches` / `start` / `end` look correct.

### 10. UI automation brittleness (most likely real failures)
- [ ] **Settings (⋮)** still found after Google UI tweaks.
- [ ] **Select file format** dialog still appears; Text checkbox still toggles.
- [ ] Shadow DOM scrape still finds `.item` + `Created on …` aria-labels.
- [ ] “Load more” still discovered when the library is large.
- [ ] Long jobs: service worker stays alive (alarms) through multi-file batches.

---

## Quick repro matrix

| Scenario | Expect |
|----------|--------|
| Today only, 2–5 sessions | Fast list, early stop, N matches |
| Yesterday only | May scroll past today first, then stop after older-than-yesterday |
| Last 7 days | Longer list; includes oldest day of range |
| Empty range day | `0 match(es)`, no downloads |
| Dry-run on | List + manifest only |

## Where to look in code

| Area | File |
|------|------|
| Early-stop listing | `content/content.js` → `listRecordings` |
| Date parse / range | `lib/dates.js`, `content/content.js` helpers |
| Job + downloads rename | `background/service-worker.js` |
| Popup options / progress | `popup/popup.js`, `popup/popup.html` |
