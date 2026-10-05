# Recorder Transcript Batch Downloader (Chrome Extension)

Beautiful, minimal Chrome extension that batch-downloads **text transcripts (`.txt` only)** from [Google Recorder](https://recorder.google.com/) for a **date range** you choose.

It automates the same web UI path as the CLI tool: open each matching recording → **⋮ Settings → Download → Text file (.txt)**.

An optional **Experimental** mode skips the Download dialog entirely: it switches the recording to the **Transcript** view, reads the transcript text straight from the page, and saves it as a `.txt` file (see [Experimental mode](#experimental-mode)).

---

## Install (unpacked)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder  
   (`Google Recorder Transcript Chrome Extension`)
4. Pin the extension from the puzzle-piece menu

---

## Use

1. Sign into the Google account that owns your Recorder library (any tab is fine).
2. Click the extension icon.
3. Pick a **preset** (Today, 3 days, 7 days, …) or set **Start / End** dates.
4. Options:
   - **Dry-run** — list matches only, no downloads  
   - **Force re-download** — don’t skip names already in Downloads  
   - **Export manifest** — write a JSON summary when finished  
   - **Experimental: read transcript directly** — skip the Download dialog; read the Transcript view instead (see below)  
   - **Pacing delay** — wait between downloads (classic mode): *No delay*, 2, 4 (default), 7 or 10 seconds  
5. **Start**. The extension opens or focuses `recorder.google.com` and runs the batch.
6. Files land in your **Chrome Downloads** folder as:

   ```text
   YYYY-MM-DD_Sanitized-Title.txt
   ```

Keep the Recorder tab visible while a job runs. You can close the popup; progress is retained for the session.

---

## Experimental mode

Enable **Experimental: read transcript directly** in the popup. For each recording the extension:

1. Opens the recording in the sidebar.
2. Makes sure the **Transcript** view button is pressed (it presses it if not).
3. Reads the text of the `Recording transcript` panel, including speaker labels and timestamps, formatted as it appears on screen. Recorder renders the transcript inside shadow DOM, so plain `innerText` returns nothing; the extension walks the shadow roots itself.
4. Saves it as `YYYY-MM-DD_Sanitized-Title.txt` using the same naming as the classic mode.

How it differs from the classic mode:

- No ⋮ menu, no format dialog, no "Downloading transcript…" toast wait.
- No fixed sleeps. It polls every ~60 ms until the transcript for **that** recording is on screen (matching title, non-empty, stable across two reads), then moves straight to the next one. The pacing delay setting is ignored.
- If the transcript is empty, the button or panel is missing, or nothing updates within 15 seconds, that recording is marked `failed` in the results/manifest and the job continues. Re-running the same range retries only the failures, since saved files are skipped.
- Known limitation: two recordings with **identical** transcript text (for example a "Copy of …" duplicate) can make the second one fail, because identical text is treated as stale.
- Off by default; the classic mode is unchanged.

---

## Permissions

| Permission | Why |
|------------|-----|
| `tabs` / `scripting` | Find/open Recorder and inject the automator |
| `downloads` | Save/rename `.txt` files and export the manifest |
| `storage` | Job state + remembered options |
| `alarms` | Keep the service worker alive during long jobs |
| Host: `recorder.google.com` | Only that site is automated |

---

## Project layout

```text
manifest.json
popup/          # Dark minimal UI
background/     # Service worker (job state, downloads, tab)
content/        # Recorder DOM automation
lib/dates.js    # Date range + filename helpers
icons/
README.md
```

---

## Constraints & limitations

1. **UI automation is brittle** — Google can change Recorder’s shadow DOM, labels (`Settings`, `Created on …`), or the download dialog. If that happens, selectors in `content/content.js` need updates.
2. **Created date only** — matching uses Recorder’s **Created on** metadata, not free-text titles.
3. **macOS/Windows Downloads folder** — Chrome extensions cannot freely pick arbitrary folders; files go to the browser Downloads location (with suggested filenames).
4. **You must be signed in** — the extension does not perform Google login for you.
5. **Sequential downloads** — one recording at a time; large ranges take a while.
6. **Skip existing** is best-effort via `chrome.downloads` history; renamed/moved files may download again unless you use judgment or **Force**.
7. **Does not download audio**, edit speakers, or use a private Google export API.
8. **Never clicks Delete.**

---

## Troubleshooting

| Issue | Try |
|-------|-----|
| Nothing happens | Open Recorder manually, confirm you’re signed in, click **Open Recorder**, then Start |
| Empty match list | Wrong dates; click Load more in the UI once; re-run Dry-run |
| Stuck on Settings/Download | Keep the tab focused; dismiss dialogs; re-run with a smaller range |
| Wrong filename | Check Downloads; conflict may append `(1)` |
| Experimental: "Transcript text was empty or did not update" | Recording may have no transcript yet, or be identical to the previous one; re-run the range to retry only the failures |
| Files save as `download.txt` | Reload the extension so the latest service worker is active |
| Job interrupted | Re-open popup; if Idle, Start again (completed files skip unless Force) |

---

## Related

CLI / CDP version: [Google-Recorder-Batch-Transcript-Downloader](https://github.com/hectorir/Google-Recorder-Batch-Transcript-Downloader)

---

## License

For personal use with your own Google Recorder library. Respect Google’s Terms of Service.
