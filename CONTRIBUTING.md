# Contributing to Aurelune

Thanks for wanting to help! Aurelune is a self-hosted music and podcast platform
built with Node.js, Express, MongoDB and a no-build vanilla JavaScript client.
Bug reports, fixes, docs, translations and ideas are all welcome.

Please read these first:

* [Code of Conduct](CODE_OF_CONDUCT.md): be kind. It applies everywhere in the project.
* [LICENSE](LICENSE): Aurelune is **free for non-commercial use**. Commercial use needs a
  separate license from the author (see below).
* [SECURITY.md](SECURITY.md): **do not report vulnerabilities in public issues.**

## Ways to contribute

* **Report a bug**: use the *Bug report* issue form. A good report has the exact steps, what
  you expected, what happened, and your platform (browser or desktop app, local or PostFile storage).
* **Suggest a feature**: use the *Feature request* form and explain the problem before the solution.
  For anything big, open an issue and talk it through **before** writing code, so your time isn't wasted.
* **Send a pull request**: fixes, docs and tests are always appreciated.
* **Improve the docs**: the README is long; clearer wording and corrections help a lot.

## Contribution terms (important)

Aurelune is licensed under the [Aurelune Non-Commercial License](LICENSE). By submitting a pull
request, patch or other contribution you agree to section 5 of that license: your contribution is
licensed under the same license, **and** you grant the author the right to use and relicense it,
including under commercial terms (this is what allows the author to offer commercial licenses at all).
Only submit work that is yours to give (no code copied from projects with incompatible licenses, and
nothing from your employer unless they allow it).

## Getting set up

You need **Node.js 18.17+** and **MongoDB 6+** (a local `mongod`, Docker, or an Atlas cluster).

```bash
git clone <your fork>
cd aurelune
npm install
cp .env.example .env     # a local MongoDB needs no changes
npm start                # http://localhost:3000
npm run dev              # same, restarting on server changes
```

On the first run an admin account is created and a demo catalog is seeded (the audio is generated
by `server/synth.js`, not real music). Log in as `demo` / `demo12345`, or use the admin credentials
printed in the console.

The desktop app: `npm run desktop`. The mobile shell is described in the README.

### Project layout

```
server/       Express API (app.js, routes/, db.js models, storage.js, pfstream.js, ...)
public/       The web client: vanilla ES modules, no bundler, no build step
electron/     Desktop shell
test/         jsdom tests (npm test) and test/integration (needs MongoDB + a running server)
scripts/      helper scripts, including a mock PostFile server
```

## Making a change

1. **Fork** the repository and create a branch from `main`: `fix/lyrics-seek`, `feat/queue-panel`.
2. Keep the change **focused**: one problem per pull request. Unrelated clean-ups belong in their own PR.
3. Follow the style of the code around you:
   * ES modules everywhere (`import` / `export`), no new build tooling or frontend framework.
   * The client is plain JavaScript and HTML strings; **escape user text** with `esc()` before it goes into markup.
   * Server routes are async and throw `HttpError` for expected failures. Respect the privacy filters
     (`publicFilter`, `visibleTo`, `notBlocked`): private tracks, episodes and creator pages must never leak.
   * Never commit secrets, `.env`, `data/`, or real API keys.
4. **Test it.** Run `npm test` (no database needed). For server behaviour, add or run the
   scripts in `test/integration/` (see its README). If you fix a bug, add a test that fails without the fix.
5. **Check the UI** yourself on a narrow (phone) and a wide (desktop) window, and in both the web
   app and, if you touched player or keyboard code, the desktop app.
6. Update the **README / `.env.example`** if you add a setting or change behaviour.
7. Open a pull request and fill in the template. Link the issue it solves (`Fixes #123`).

### Commit messages

Short and in the imperative, with a bit of context in the body when it helps:

```
Fix lyric click-to-seek landing one line late

The active line was computed before the seek finished playing, so the highlight ...
```

### Review

I try to look at pull requests within a week or so. Reviews are about the code, never the person.
Small, well-tested PRs get merged fastest. If a PR sits without an answer for a while, a polite nudge is welcome.

## Commercial use

If you want to use Aurelune (or a modified version of it) for anything commercial (a paid or
ad-supported service, a company's product or internal tooling, consulting built around it), please
email the project owner ([RealUnfazed](https://github.com/RealUnfazed), the address is on his profile) first to get a commercial license. Contributing here does not give you any
commercial rights over the code.

## Questions

Check the README and existing issues first. If you are still stuck, see [SUPPORT.md](SUPPORT.md).
