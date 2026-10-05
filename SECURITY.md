# Security Policy

Aurelune handles accounts, private creator pages, uploaded audio and storage API
keys, so security reports are taken seriously. Thank you for helping keep it safe.

## Supported versions

Only the latest release (the current `main` branch) gets security fixes. If you
run a fork or an older copy, please update before reporting, or tell us exactly
which commit you tested.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Use one of these private channels:

1. **GitHub private vulnerability reporting**: on the repository's *Security* tab,
   choose *Report a vulnerability*. (Preferred.)
2. **Email**: the address on the GitHub profile of the project owner, Alireza Asakareh ([RealUnfazed](https://github.com/RealUnfazed)), with the subject `Aurelune security`.

Please include:

* what the problem is and what an attacker could do with it;
* the steps to reproduce it (a request, a script, or a short description is fine);
* the affected version or commit, and how you run Aurelune (web, Vercel, desktop,
  local or PostFile storage);
* any logs or screenshots, with secrets removed.

If you can, please give us a reasonable amount of time to fix the issue before
you discuss it publicly.

## What to expect

* We aim to acknowledge your report within **3 working days**.
* We aim to give you an assessment and a plan within **10 working days**.
* We will keep you updated until it is fixed, and credit you in the release notes
  if you would like (tell us how you want to be named, or that you prefer not to be).

This is a volunteer-run, non-commercial project, so there is no bug bounty, but we are
grateful for every report.

## In scope

* Authentication, sessions, password reset and API tokens
* Access control: private tracks, private episodes and private creator pages,
  collaboration invites, admin-only routes
* Upload handling (file type checks, size limits, part-by-part uploads), the
  stitched stream/proxy endpoints, and anything that fetches a URL on the server
  (SSRF)
* Leaking of storage keys (`POSTFILE_API_KEYS`) or other secrets
* Injection (NoSQL, XSS, HTML/markup in titles, bios, lyrics, comments)
* The Electron and Capacitor shells

## Out of scope

* Findings that need an already compromised device, browser or account
* Missing best-practice headers with no demonstrated impact
* Denial of service through sheer traffic volume, and automated scanner output
  without a working proof of concept
* The public demo content and the fact that the demo catalog is synthesized
* Vulnerabilities in third-party services (MongoDB Atlas, PostFile, Vercel);
  please report those to the vendor
* Audio that can be saved by a determined listener: Aurelune does not claim to
  provide DRM (see the README, "A note on file protection")

## Good-faith research

If you act in good faith, stay within the scope above, avoid privacy violations,
data destruction and service disruption, and report privately, we will not take
action against you. Please only test against your own installation or accounts,
not other people's data.

## Hardening checklist for people who run Aurelune

* Set strong, unique values for the secrets in `.env`, and never commit `.env`.
* Keep `POSTFILE_API_KEYS` and your database URI out of client code and issue reports.
* Use HTTPS in production and restrict database network access where you can.
* In production set `ADMIN_PASSWORD` yourself (no default-password admin is created there); on a local first run, change the printed admin password straight away (Settings → Password).
* Keep Node.js and your dependencies up to date.
