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
