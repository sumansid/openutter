# OpenUtter

<img width="1376" height="768" alt="Generated Image March 01, 2026 - 2_20PM (1)" src="https://github.com/user-attachments/assets/ce352f31-d381-450d-af6a-a01e57b13d6d" />

OpenUtter is a headless Google Meet bot for OpenClaw. It can join meetings,
capture live captions into a transcript, and take on-demand screenshots.

GitHub: https://github.com/sumansid/openutter

## Install

```bash
npx openutter
```

This installs the OpenUtter skill into:

```bash
~/.openclaw/skills/openutter
```

For example, on a Linux host running OpenClaw as the `openclaw` user, that path
would usually be:

```bash
/home/openclaw/.openclaw/skills/openutter/
```

By default, OpenUtter installs into that shared OpenClaw skills directory no
matter which folder you run `npx openutter` from.

If you want to install into a specific location instead, use `--target-dir`:

```bash
npx openutter --target-dir ./skills/openutter
```

That is useful if you want a repo-local/workspace-local install instead of the
default shared install under `~/.openclaw/skills/openutter`.

During install, OpenUtter also tries to:

- install Chromium via Playwright
- verify Chromium can actually launch
- auto-install Linux runtime dependencies when supported and running as root

If Linux system dependencies are missing and OpenUtter cannot install them
automatically, it prints the exact command to run.

If you ever want to install Chromium manually, you can still run:

```bash
npx playwright-core install chromium
```

At that point, OpenUtter is ready for guest joins. Google account auth is
optional and only needed if you want to join with `--auth` instead of waiting
in the guest lobby.

## Commands

```bash
npx openutter join <meet-url> --anon --bot-name "OpenUtter Bot"
npx openutter join <meet-url> --auth
npx openutter join <meet-url> --auth --headed
npx openutter auth
npx openutter transcript
npx openutter transcript --last 20
npx openutter screenshot
```

## What It Does

1. Joins a Google Meet call as a guest or authenticated user.
2. Enables Google Meet live captions.
3. Captures captions in real time via DOM observation.
4. Writes a deduplicated transcript to disk.
5. Supports on-demand screenshots.

## Authenticate Once (Optional)

Authentication is optional.

By default, OpenUtter can join as a guest with:

```bash
npx openutter join <meet-url> --anon --bot-name "Your Bot Name"
```

Guest mode works, and OpenUtter retries the join flow up to 3 times when Meet
blocks or drops the request. But authentication is the best way to make sure
the bot gets admitted reliably, because it joins as your signed-in Google
account with `--auth` instead of waiting in the guest lobby for host approval.

To save a Google session for authenticated joins:

```bash
npx openutter auth
```

This opens a browser window. Sign in to Google, then press Enter in the
terminal. Your session is saved to:

```bash
~/.openutter/auth.json
```

After that, you can join with:

```bash
npx openutter join <meet-url> --auth
```

## Join a Meeting

Guest mode:

```bash
npx openutter join https://meet.google.com/abc-defg-hij --anon --bot-name "My Bot"
```

Authenticated mode:

```bash
npx openutter join https://meet.google.com/abc-defg-hij --auth
```

Headed mode for debugging:

```bash
npx openutter join https://meet.google.com/abc-defg-hij --auth --headed
```

This opens the Chromium window instead of running fully headless, which is
useful if you need to debug login, admission, or caption issues.

Common options:

- `--headed` shows the browser for debugging
- `--duration 30m` auto-leaves after a duration
- `--channel <channel>` sends status updates through OpenClaw
- `--target <id>` sets the target chat for those updates
- `--verbose` prints live caption activity

## Transcript

Read the latest transcript:

```bash
npx openutter transcript
```

Read only the latest lines:

```bash
npx openutter transcript --last 20
```

Transcripts are saved under:

```bash
~/.openclaw/workspace/openutter/transcripts/<meeting-id>.txt
```

OpenUtter uses the Google Meet meeting ID as the transcript filename. For
example, joining `https://meet.google.com/abc-defg-hij` saves captions to:

```bash
~/.openclaw/workspace/openutter/transcripts/abc-defg-hij.txt
```

Example format:

```text
[14:30:05] Alice: Hey everyone, let's get started
[14:30:12] Bob: Sounds good, I have the updates ready
[14:30:25] Alice: Great, go ahead
```

## Screenshot

Request an on-demand screenshot from a running meeting:

```bash
npx openutter screenshot
```

## Files

- `~/.openutter/auth.json` saved Google session
- `~/.openutter/auth-meta.json` saved login metadata
- `~/.openutter/chrome-profile/` persistent Chromium profile
- `~/.openclaw/workspace/openutter/transcripts/` transcript output
- `~/.openclaw/workspace/openutter/on-demand-screenshot.png` screenshot output
- `~/.openclaw/workspace/openutter/debug-join-failed.png` join failure screenshot
- `~/.openclaw/workspace/openutter/debug-admit-failed.png` admit failure screenshot

## Troubleshooting

- If Chromium is missing, run `npx playwright-core install chromium`.
- If guest join is stuck, ask the host to admit your bot by name.
- If captions are empty, retry with `--headed --verbose` to verify captions were enabled.
- If your Google session expires, run `npx openutter auth` again.

## Release

This repo can publish directly to npm from GitHub Actions.

1. Bump `package.json` to the new version.
2. Commit and push to `main`.
3. Create and push a matching tag like `v0.1.1`.
4. GitHub Actions publishes that exact version to npm.

The workflow validates that the git tag matches `package.json`.
