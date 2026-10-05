## What does this change?

<!-- A short summary of the change and why it's needed. Link the issue: "Fixes #123" -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs only
- [ ] Refactor / cleanup (no behaviour change)
- [ ] Tests only
- [ ] Other:

## Area

- [ ] Web client (`public/`)
- [ ] Server / API (`server/`)
- [ ] Desktop (`electron/`)
- [ ] Storage / uploads
- [ ] Docs / config

## How was it tested?

<!-- Commands you ran, browsers/OS you tried, and what you saw. For bug fixes: the test that fails without your fix. -->

- [ ] `npm test` passes
- [ ] I ran the relevant scripts in `test/integration/` (if I touched the server)
- [ ] I tried it in the browser (phone-size and desktop-size) and, for player/keyboard changes, the desktop app

## Screenshots / recordings

<!-- For anything visual. Delete this section if not needed. -->

## Checklist

- [ ] The change is focused: one problem per pull request
- [ ] I followed the existing code style (ES modules, no new build tooling, user text escaped with `esc()`)
- [ ] Private tracks, episodes and creator pages still can't leak (privacy filters respected)
- [ ] No secrets, `.env`, `data/` or real API keys are included
- [ ] I updated the README / `.env.example` if behaviour or settings changed
- [ ] I read [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md) and agree that my contribution is licensed under the
      [project license](../blob/main/LICENSE) (section 5), including the author's right to relicense it commercially
