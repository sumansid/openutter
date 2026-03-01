# OpenUtter

A headless Google Meet bot that joins meetings via Playwright and captures live captions as a real-time transcript. Built as an [OpenClaw](https://github.com/AshishKapoor/openclaw) skill.

## What it does

1. Joins a Google Meet call as a guest or authenticated user (headless Chromium)
2. Enables Google Meet's built-in live captions
3. Captures captions in real-time via a DOM MutationObserver
4. Writes a deduplicated, timestamped transcript to disk
5. Supports on-demand screenshots of the meeting

## Prerequisites

- Node.js 18+
- [Playwright](https://playwright.dev/) Chromium browser:
  ```bash
  npx playwright-core install chromium
  ```

## Quick start

### Join a meeting as a guest

```bash
npx tsx skills/openutter/scripts/utter-join.ts https://meet.google.com/abc-defg-hij \
  --anon --bot-name "My Bot"
```

The host will need to admit the bot from the lobby.

### Join as an authenticated Google user

First, save your Google session (one-time):

```bash
npx tsx skills/openutter/scripts/utter-auth.ts
```

This opens a browser window. Sign into Google, then press Enter. Your session is saved to `~/.openutter/auth.json`.

Then join with `--auth` (no host admission needed):

```bash
npx tsx skills/openutter/scripts/utter-join.ts https://meet.google.com/abc-defg-hij --auth
```

## Scripts

| Script                | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `utter-join.ts`       | Join a Google Meet and capture captions               |
| `utter-auth.ts`       | Save a Google account session for authenticated joins |
| `utter-transcript.ts` | Print the latest transcript from a running session    |
| `utter-screenshot.ts` | Take a screenshot of the current meeting view         |

## Options

```
utter-join.ts <meet-url> --auth|--anon [options]

Required (one of):
  --auth                 Join using saved Google account (~/.openutter/auth.json)
  --anon --bot-name <n>  Join as a guest with this display name

Options:
  --headed               Show the browser window (debugging)
  --camera               Join with camera on (default: off)
  --mic                  Join with mic on (default: off)
  --duration <time>      Auto-leave after duration (e.g. 30m, 1h, 90s)
  --channel <channel>    Messaging channel for status updates
  --target <id>          Chat target ID for status updates
  --verbose              Print captions to stdout as they're captured
```

## Transcript format

Transcripts are saved to `~/.openclaw/workspace/openutter/transcripts/<meeting-id>-<YYYY-MM-DD>.txt`:

```
[14:30:05] Alice: Hey everyone, let's get started
[14:30:12] Bob: Sounds good, I have the updates ready
[14:30:25] Alice: Great, go ahead
```

To read the latest transcript while a meeting is active:

```bash
npx tsx skills/openutter/scripts/utter-transcript.ts           # full transcript
npx tsx skills/openutter/scripts/utter-transcript.ts --last 20  # last 20 lines
```

## How it works

1. **Launch** -- Spawns headless Chromium with stealth patches (spoofed `navigator.webdriver`, fake plugins, WebGL renderer) to avoid bot detection.

2. **Join** -- Navigates to the Meet URL, enters the bot name, clicks "Ask to join" / "Join now", and waits up to 10 minutes for host admission. If blocked, retries with a fresh incognito context (up to 3 attempts).

3. **Caption capture** -- After joining, enables Google Meet's live captions (tries CC button click, keyboard shortcut `c`, `Shift+C`, and the More Options menu). Injects a MutationObserver that watches the caption container for new nodes and `characterData` changes. Speaker names are extracted from `.NWpY1d` / `.xoMHSc` badge elements.

4. **Deduplication** -- Google Meet updates captions word-by-word as speech is recognized. The bot tracks in-progress text per speaker and only finalizes a caption line when the text hasn't changed for 5 seconds.

5. **Screenshot** -- The bot writes its PID to `~/.openutter/otter.pid`. The `utter-screenshot.ts` script sends `SIGUSR1` to trigger an on-demand screenshot.

## Resource usage

Measured on a single bot session (Apple M-series / headless):

| Component                                   | Processes | RSS         |
| ------------------------------------------- | --------- | ----------- |
| Node (bot)                                  | 3         | ~350 MB     |
| Chromium (browser + gpu + renderer + audio) | 5-6       | ~900 MB     |
| **Total**                                   | **~9**    | **~1.2 GB** |

CPU usage is ~6% of a single core during active caption capture, with spikes during join. Runs fully headless with no display server required.

## File locations

| Path                                                       | Description                                   |
| ---------------------------------------------------------- | --------------------------------------------- |
| `~/.openutter/auth.json`                                   | Saved Google session (cookies + localStorage) |
| `~/.openutter/auth-meta.json`                              | Login metadata (email, timestamp)             |
| `~/.openutter/chrome-profile/`                             | Persistent Chromium profile (guest mode)      |
| `~/.openutter/config.json`                                 | Bot configuration (optional)                  |
| `~/.openclaw/workspace/openutter/transcripts/`             | Caption transcripts                           |
| `~/.openclaw/workspace/openutter/joined-meeting.png`       | Post-join confirmation screenshot             |
| `~/.openclaw/workspace/openutter/on-demand-screenshot.png` | On-demand screenshot                          |
| `~/.openclaw/workspace/openutter/debug-*.png`              | Debug screenshots on failure                  |

## Troubleshooting

**Bot can't join / "You can't join this video call"**
Google Meet sometimes blocks headless browsers. The bot retries with fresh incognito contexts up to 3 times. Check the debug screenshot at `~/.openclaw/workspace/openutter/debug-join-failed.png`. Try `--headed` to debug visually.

**No captions captured**
Google Meet's CC button selector changes occasionally. If the transcript is empty, captions may not have been enabled. Run with `--headed --verbose` to verify the CC button is being clicked.

**Session expired**
Re-run `utter-auth.ts` to sign in again. The old session is overwritten automatically.

**Host didn't admit the bot**
In guest mode (`--anon`), the bot waits in the lobby for up to 10 minutes. Ask the host to admit your bot by name. For instant access, use `--auth` with a saved Google session.

## License

MIT
