# Integration scripts

End-to-end checks that talk to a running server over HTTP. They are not part of `npm test` (which is jsdom only).

- `fakepf.mjs` – a fake multi-key PostFile (API + CDN) on port 4010. Control endpoint `/_ctl` makes a key fail with
  quota/auth/rate-limit/etc., `/_stats` reports uploads per key and CDN hits.
- `pf.mjs` – key rotation, failover, multi-part upload and stitched streaming (ranges across seams), part-by-part
  session upload, cleanup on delete.
- `collab.mjs` – collaborator invites, accept/decline, visibility on artist pages.
- `private.mjs` – private tracks / private creator pages.
- `runpf.sh` – starts MongoDB-compatible DB, the fake PostFile and the server with 3 keys and 6 MB parts, then runs a script:
  `bash test/integration/runpf.sh test/integration/pf.mjs`. Adjust the database start-up lines for your machine.
- `keys_selection.py` – Playwright: Space in a text box types a space (doesn't pause), Space elsewhere toggles playback,
  Ctrl/Cmd+Arrow only skips tracks in the desktop app and never inside a text box, and non-input text can't be selected.
  Run with `bash test/integration/runpf.sh test/integration/keys_selection.py` (Python `playwright` required).
- `show_privacy.mjs` / `show_privacy_ui.py` – private podcasts, empty podcasts not being advertised, legacy shows without the field, and
  removing an API token in the UI. Run with `bash test/integration/runpf.sh test/integration/show_privacy.mjs`.
- `desktop_modes.py` – launches the real Electron app (xvfb on Linux) in **client** mode (address from env, typed on the connect screen, saved,
  server down) and **full** mode (starts its own server). Needs the app server running on :3000 and MongoDB on :27017.
- `player_ui.py` – Playwright: animations on by default even with OS reduced-motion, the Appearance switch (saved, survives reload),
  the seek-bar hover time box, seeking never jumping to 0, `Range` edge cases on `/stream/track/:id`, and the phone full-screen player
  (390 px wide, touch). Run with `bash /path/to/runner test/integration/player_ui.py` against a server with the demo catalog.
- `desktop_modes.py` also covers the **locked** client build (written `build-config.json` with a server): overrides ignored, error
  screen without an address box, connect call refused.
- `seek_proxy.mjs` – the `?proxy=1` route against a file host that honours Range and one that ignores it: exact 206 windows, open-ended
  and suffix ranges, 416, clamping, ETag/304, cache headers, errors never cached, anonymous never gets a 304. `bash runpf.sh test/integration/seek_proxy.mjs`.
- `seek_ui.py` – Playwright against a slow, Range-ignoring file host: seeking forward/back/click never lands at 0 (direct-CDN and proxy
  modes), repeat one/all make no new requests to the file host, replays come from cache, and the server survives aborted streams.
  The stand-in host (`fakepf.mjs`) now has `slowKBps` and answers 416 for a start past the end.
- `seek_fuzz.py` – randomised seeking (bar clicks, `seekTo`, lyric clicks, ±5 s steps, pause/play/toggle at random moments, while the song downloads or plays, blob and stream modes, with/without CORS and Range): the song must end where the last seek asked, never at the start. Prints its seed.
