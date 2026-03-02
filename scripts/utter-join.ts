#!/usr/bin/env npx tsx
/**
 * utter-join.ts — Join a Google Meet meeting as a guest via Playwright
 *
 * Usage:
 *   npx tsx skills/openutter/scripts/utter-join.ts <meet-url>
 *   npx tsx skills/openutter/scripts/utter-join.ts https://meet.google.com/abc-defg-hij
 *   npx tsx skills/openutter/scripts/utter-join.ts <meet-url> --bot-name "My Bot" --duration 60m
 *
 * No Google account or OAuth required — joins as a guest and waits for host admission.
 */

import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type PlaywrightMod = typeof import("playwright-core");
type Page = import("playwright-core").Page;
type BrowserContext = import("playwright-core").BrowserContext;

const OPENUTTER_DIR = join(homedir(), ".openutter");
const OPENUTTER_WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace", "openutter");
const CONFIG_FILE = join(OPENUTTER_DIR, "config.json");
const AUTH_FILE = join(OPENUTTER_DIR, "auth.json");
const PID_FILE = join(OPENUTTER_DIR, "otter.pid");
const SCREENSHOT_READY_FILE = join(OPENUTTER_WORKSPACE_DIR, "screenshot-ready.json");
const TRANSCRIPTS_DIR = join(OPENUTTER_WORKSPACE_DIR, "transcripts");

// ── Send image directly to channel ──────────────────────────────────────

/**
 * Send an image to the user's chat via `openclaw message send --media`.
 * If channel/target aren't provided, falls back to printing the marker.
 */
function sendImage(opts: {
  channel?: string;
  target?: string;
  message: string;
  mediaPath: string;
}): void {
  if (opts.channel && opts.target) {
    try {
      execSync(
        `openclaw message send --channel ${opts.channel} --target ${JSON.stringify(opts.target)} --message ${JSON.stringify(opts.message)} --media ${JSON.stringify(opts.mediaPath)}`,
        { stdio: "inherit", timeout: 30_000 },
      );
      console.log(`  Sent image to ${opts.channel}:${opts.target}`);
    } catch (err) {
      console.error("Failed to send image:", err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Send a text-only progress message to the user's chat.
 */
function sendMessage(opts: { channel?: string; target?: string; message: string }): void {
  if (opts.channel && opts.target) {
    try {
      execSync(
        `openclaw message send --channel ${opts.channel} --target ${JSON.stringify(opts.target)} --message ${JSON.stringify(opts.message)}`,
        { stdio: "inherit", timeout: 30_000 },
      );
    } catch {
      // Best-effort — don't block the bot if message fails
    }
  }
}

// ── CLI parsing ────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const meetUrl = args.find((a) => !a.startsWith("--"));
  const headed = args.includes("--headed");
  const useAuth = args.includes("--auth");
  const useAnon = args.includes("--anon");
  // Default: camera and mic OFF (bot should join muted). Use --camera / --mic to enable.
  const noCamera = !args.includes("--camera");
  const noMic = !args.includes("--mic");
  const verbose = args.includes("--verbose");
  const durationIdx = args.indexOf("--duration");
  const durationRaw = durationIdx >= 0 ? args[durationIdx + 1] : undefined;
  const botNameIdx = args.indexOf("--bot-name");
  const botName = botNameIdx >= 0 ? args[botNameIdx + 1] : undefined;
  const channelIdx = args.indexOf("--channel");
  const channel = channelIdx >= 0 ? args[channelIdx + 1] : undefined;
  const targetIdx = args.indexOf("--target");
  const target = targetIdx >= 0 ? args[targetIdx + 1] : undefined;

  if (!meetUrl) {
    console.error(
      "Usage: npx tsx utter-join.ts <meet-url> --auth|--anon [--camera] [--mic] [--duration 60m] [--bot-name <name>] [--channel <channel>] [--target <id>]",
    );
    process.exit(1);
  }

  if (!useAuth && !useAnon) {
    console.error("ERROR: You must specify either --auth or --anon.");
    console.error("ASK THE USER which mode they want before retrying. Do NOT choose for them.");
    console.error("  --auth  Join using saved Google account (~/.openutter/auth.json)");
    console.error("  --anon  Join as a guest (no Google account)");
    process.exit(1);
  }

  if (useAuth && useAnon) {
    console.error("ERROR: Cannot use both --auth and --anon.");
    process.exit(1);
  }

  if (useAnon && !botName) {
    console.error("ERROR: --anon requires --bot-name <name>.");
    console.error("ASK THE USER what name they want the bot to use. Do NOT choose a default.");
    process.exit(1);
  }

  // Parse duration to milliseconds
  let durationMs: number | undefined;
  if (durationRaw) {
    const match = durationRaw.match(/^(\d+)(ms|s|m|h)?$/);
    if (match) {
      const value = Number.parseInt(match[1]!, 10);
      const unit = match[2] ?? "ms";
      const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
      durationMs = value * (multipliers[unit] ?? 1);
    }
  }

  const noAuth = useAnon;
  return {
    meetUrl,
    headed,
    noAuth,
    noCamera,
    noMic,
    verbose,
    durationMs,
    botName,
    channel,
    target,
  };
}

// ── Google Meet UI automation ──────────────────────────────────────────

/**
 * Detect if Google Meet has blocked us with "You can't join this video call".
 * Returns true if blocked.
 */
async function isBlockedFromJoining(page: Page): Promise<boolean> {
  try {
    const blocked = page
      .locator("text=/You can't join this video call/i, text=/can.t join this video call/i")
      .first();
    return await blocked.isVisible({ timeout: 2000 });
  } catch {
    return false;
  }
}

/**
 * Dismiss pre-join overlays: "Sign in with your Google account" tooltip,
 * "Your meeting is safe", cookie consent, "Use Gemini to take notes", etc.
 * Runs multiple rounds since popups can appear sequentially.
 */
async function dismissOverlays(page: Page): Promise<void> {
  const dismissTexts = ["Got it", "Dismiss", "OK", "Accept all", "Continue without microphone", "No thanks"];

  for (let round = 0; round < 3; round++) {
    let dismissed = false;

    // Click dismiss/close buttons
    for (const text of dismissTexts) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          console.log(`  Dismissed overlay ("${text}")`);
          dismissed = true;
          await page.waitForTimeout(500);
        }
      } catch {
        // Button not present, that's fine
      }
    }

    // Dismiss "Use Gemini to take notes" banner — click away from it or press Escape
    try {
      const gemini = page.locator('text=/Use Gemini/i').first();
      if (await gemini.isVisible({ timeout: 1000 })) {
        await page.keyboard.press("Escape");
        console.log("  Dismissed Gemini banner");
        dismissed = true;
        await page.waitForTimeout(500);
      }
    } catch {
      // Not present
    }

    // Press Escape to close any remaining tooltips/popups
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    if (!dismissed) break;
  }
}

/**
 * Dismiss dialogs that appear after joining the meeting.
 * e.g. "Others may see your video differently" with a "Got it" button,
 * or "Your meeting is safe" info cards.
 */
async function dismissPostJoinDialogs(page: Page): Promise<void> {
  await page.waitForTimeout(2000);

  // Try multiple rounds — dialogs can appear sequentially
  for (let round = 0; round < 3; round++) {
    let dismissed = false;

    // Click any "Got it", "OK", "Dismiss", "Close" buttons in dialogs
    for (const text of ["Got it", "OK", "Dismiss", "Close"]) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          console.log(`  Dismissed post-join dialog ("${text}")`);
          dismissed = true;
          await page.waitForTimeout(500);
        }
      } catch {
        // Not present
      }
    }

    // Also try Escape to close any modal
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    if (!dismissed) break;
  }
}

/**
 * Turn off camera and microphone on the pre-join page.
 */
async function disableMediaOnPreJoin(page: Page, opts: { noCamera: boolean; noMic: boolean }) {
  if (opts.noMic) {
    try {
      // Try data-is-muted attribute first, then RecallAI's aria-label pattern
      const micBtn = page
        .locator(
          '[aria-label*="microphone" i][data-is-muted="false"], ' +
            'button[aria-label*="Turn off microphone" i]',
        )
        .first();
      if (await micBtn.isVisible({ timeout: 3000 })) {
        await micBtn.click();
        console.log("  Microphone turned off");
      }
    } catch {
      // Already muted or not visible
    }
  }

  if (opts.noCamera) {
    try {
      const camBtn = page
        .locator(
          '[aria-label*="camera" i][data-is-muted="false"], ' +
            'button[aria-label*="Turn off camera" i]',
        )
        .first();
      if (await camBtn.isVisible({ timeout: 3000 })) {
        await camBtn.click();
        console.log("  Camera turned off");
      }
    } catch {
      // Already off or not visible
    }
  }
}

/**
 * Enter the bot's display name in the "Your name" field if it's shown (guest join).
 */
async function enterNameIfNeeded(page: Page, botName: string): Promise<void> {
  try {
    const nameInput = page
      .locator('input[aria-label="Your name"], input[placeholder*="name" i]')
      .first();
    if (await nameInput.isVisible({ timeout: 3000 })) {
      await nameInput.fill(botName);
      console.log(`  Set display name: ${botName}`);
    }
  } catch {
    // Name field not shown — might be signed in already
  }
}

/**
 * Click the "Join now", "Ask to join", or similar button.
 */
async function clickJoinButton(page: Page, maxAttempts = 6): Promise<boolean> {
  const joinSelectors = [
    'button:has-text("Continue without microphone and camera")',
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'button:has-text("Join meeting")',
    'button:has-text("Join")',
    '[data-idom-class*="join"] button',
    "button >> text=/join/i",
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check if we've been blocked before trying more selectors
    const isBlocked = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return (
          /you can.t join this video call/i.test(text) || /return(ing)? to home screen/i.test(text)
        );
      })
      .catch(() => false);

    if (isBlocked) {
      console.log("  Detected 'can't join' — aborting join attempt");
      return false;
    }

    for (const selector of joinSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          console.log("  Clicked join button");
          return true;
        }
      } catch {
        // Try next selector
      }
    }

    if (attempt < maxAttempts - 1) {
      console.log(`  Join button not found yet, retrying (${attempt + 1}/${maxAttempts})...`);
      // Take a debug screenshot on first retry to help diagnose
      if (attempt === 0) {
        const debugPath = join(OPENUTTER_WORKSPACE_DIR, "debug-pre-join.png");
        await page.screenshot({ path: debugPath }).catch(() => {});
        console.log(`  [OPENUTTER_DEBUG_IMAGE] ${debugPath}`);
      }
      await page.waitForTimeout(5000);
    }
  }

  return false;
}

/**
 * Wait until we detect that we're actually in the meeting.
 */
async function waitUntilInMeeting(page: Page, timeoutMs = 600_000): Promise<void> {
  console.log("  Waiting to be admitted to the meeting (up to 10 min)...");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    // Check for the end-call button — means we're in the meeting
    try {
      const endCallBtn = page
        .locator('[aria-label*="Leave call" i], [aria-label*="leave" i][data-tooltip*="Leave"]')
        .first();
      if (await endCallBtn.isVisible({ timeout: 2000 })) {
        return;
      }
    } catch {
      // Not visible yet
    }

    // "You're the only one here" or "You've been admitted" — means we're in
    try {
      const inMeetingText = page
        .locator("text=/only one here/i, text=/you.ve been admitted/i")
        .first();
      if (await inMeetingText.isVisible({ timeout: 1000 })) {
        return;
      }
    } catch {
      // Keep waiting
    }

    // Check if explicitly blocked or denied (not just waiting in lobby).
    // Use page.evaluate() for reliable text matching — Playwright text selectors
    // can be fragile with special characters and comma-separated patterns.
    const isBlocked = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return (
          /you can.t join this video call/i.test(text) ||
          /return(ing)? to home screen/i.test(text) ||
          /you have been removed/i.test(text) ||
          /denied your request/i.test(text) ||
          /meeting has been locked/i.test(text) ||
          /cannot join/i.test(text)
        );
      })
      .catch(() => false);

    if (isBlocked) {
      throw new Error("Blocked from joining — access denied or meeting unavailable");
    }

    await page.waitForTimeout(2000);
  }

  throw new Error("Timed out waiting to be admitted (10 minutes)");
}

/**
 * Detect when the meeting ends (host ends it, or we get kicked).
 */
async function waitForMeetingEnd(page: Page, durationMs?: number): Promise<string> {
  const start = Date.now();

  const checkEnded = async (): Promise<string | null> => {
    try {
      const endedText = page
        .locator(
          "text=/meeting has ended/i, text=/removed from/i, text=/You left the meeting/i, text=/You.ve left the call/i",
        )
        .first();
      if (await endedText.isVisible({ timeout: 500 })) {
        return "Meeting ended";
      }
    } catch {
      // Still in meeting
    }

    if (!page.url().includes("meet.google.com")) {
      return "Navigated away from meeting";
    }

    return null;
  };

  while (true) {
    if (durationMs && Date.now() - start >= durationMs) {
      return "Duration limit reached";
    }

    const reason = await checkEnded();
    if (reason) {
      return reason;
    }

    await page.waitForTimeout(3000);
  }
}

// ── Stealth init script to bypass headless detection ───────────────────
const STEALTH_SCRIPT = `
  // Override navigator.webdriver
  Object.defineProperty(navigator, "webdriver", { get: () => false });

  // Ensure window.chrome exists (missing in old headless)
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  // Fake plugins array (headless has 0 plugins)
  Object.defineProperty(navigator, "plugins", {
    get: () => [1, 2, 3, 4, 5],
  });

  // Fake languages
  Object.defineProperty(navigator, "languages", {
    get: () => ["en-US", "en"],
  });

  // Override permissions query for notifications
  const originalQuery = window.Permissions?.prototype?.query;
  if (originalQuery) {
    window.Permissions.prototype.query = function (params) {
      if (params.name === "notifications") {
        return Promise.resolve({ state: "default", onchange: null });
      }
      return originalQuery.call(this, params);
    };
  }

  // Patch WebGL renderer to look like a real GPU
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return "Google Inc. (Apple)";
    if (param === 37446) return "ANGLE (Apple, Apple M1, OpenGL 4.1)";
    return getParameter.call(this, param);
  };
`;

// ── On-demand screenshot via SIGUSR1 ────────────────────────────────────

/**
 * Write PID file and register a SIGUSR1 handler that takes a screenshot
 * of the given page. Call `cleanupPidFile()` on exit.
 */
export function registerScreenshotHandler(page: Page): void {
  writeFileSync(PID_FILE, String(process.pid));

  process.on("SIGUSR1", async () => {
    try {
      const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "on-demand-screenshot.png");
      await page.screenshot({ path: screenshotPath });
      const payload = JSON.stringify({ path: screenshotPath, timestamp: Date.now() });
      writeFileSync(SCREENSHOT_READY_FILE, payload);
      console.log(`[OPENUTTER_SCREENSHOT] ${screenshotPath}`);
    } catch (err) {
      console.error("Screenshot failed:", err instanceof Error ? err.message : String(err));
    }
  });
}

/**
 * Remove the PID file on exit.
 */
export function cleanupPidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // best-effort
  }
}

// ── Caption capture ────────────────────────────────────────────────────

/**
 * Extract the meeting ID from a Google Meet URL.
 * e.g. "https://meet.google.com/zxb-fxzb-rri" → "zxb-fxzb-rri"
 */
function extractMeetingId(meetUrl: string): string {
  try {
    const url = new URL(meetUrl);
    return url.pathname.replace(/^\//, "").replace(/\//g, "-") || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Enable live captions. Dismiss overlays first (Escape), then try multiple
 * methods to activate captions, verifying each one.
 * Based on: https://www.recall.ai/blog/how-i-built-an-in-house-google-meet-bot
 */
async function enableCaptions(page: Page): Promise<void> {
  // Wait for UI to stabilize after joining
  await page.waitForTimeout(5000);

  // Dismiss any overlays first — RecallAI presses Escape 8 times
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);

  // Also dismiss common overlay buttons
  for (const text of ["Got it", "Dismiss", "Continue"]) {
    try {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    } catch {
      // Not present
    }
  }

  // Strict check: look for the actual caption container, not just [aria-live]
  // which can exist on the page for other purposes
  const checkCaptions = async (): Promise<boolean> =>
    page
      .evaluate(`
      !!(document.querySelector('[role="region"][aria-label*="Captions"]') ||
         document.querySelector('[aria-label="Captions are on"]') ||
         document.querySelector('button[aria-label*="Turn off captions" i]') ||
         document.querySelector('[data-is-persistent-caption="true"]'))
    `)
      .catch(() => false) as Promise<boolean>;

  // Check if CC button shows "Turn off" (meaning captions are already on)
  const captionsAlreadyOn = await checkCaptions();
  if (captionsAlreadyOn) {
    console.log("  Captions already enabled");
    return;
  }

  // Method 1: Click the CC button directly (most reliable)
  // First, move mouse to bottom toolbar area to make it visible
  try {
    await page.mouse.move(640, 680);
    await page.waitForTimeout(1000);

    const ccButton = page
      .locator(
        'button[aria-label*="Turn on captions" i], ' +
          'button[aria-label*="captions" i][aria-pressed="false"], ' +
          'button[aria-label*="captions (c)" i]',
      )
      .first();
    if (await ccButton.isVisible({ timeout: 3000 })) {
      await ccButton.click();
      await page.waitForTimeout(2000);
      if (await checkCaptions()) {
        console.log("  Captions enabled (clicked CC button)");
        return;
      }
    }
  } catch {
    // Button not found, try keyboard shortcuts
  }

  // Method 2: press 'c' — Google Meet caption shortcut
  await page.keyboard.press("c");
  await page.waitForTimeout(2000);
  if (await checkCaptions()) {
    console.log("  Captions enabled (pressed 'c')");
    return;
  }

  // Method 3: Shift+C — retry up to 10 times (RecallAI approach)
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+c");
    await page.waitForTimeout(1000);
    if (await checkCaptions()) {
      console.log(`  Captions enabled (Shift+C, attempt ${i + 1})`);
      return;
    }
  }

  // Method 4: Click the "more options" (⋮) menu and look for captions option
  try {
    const moreBtn = page
      .locator('button[aria-label*="more options" i], button[aria-label*="More actions" i]')
      .first();
    if (await moreBtn.isVisible({ timeout: 2000 })) {
      await moreBtn.click();
      await page.waitForTimeout(1000);
      const captionsMenuItem = page
        .locator('li:has-text("Captions"), [role="menuitem"]:has-text("Captions")')
        .first();
      if (await captionsMenuItem.isVisible({ timeout: 2000 })) {
        await captionsMenuItem.click();
        await page.waitForTimeout(2000);
        if (await checkCaptions()) {
          console.log("  Captions enabled (via More Options menu)");
          return;
        }
      } else {
        // Close menu if captions item not found
        await page.keyboard.press("Escape");
      }
    }
  } catch {
    // Menu approach failed
  }

  // Method 5: Try the CC icon in the bottom bar by index (toolbar buttons)
  try {
    await page.mouse.move(640, 680);
    await page.waitForTimeout(500);
    // The CC button often has a specific icon — try matching by the closed_caption icon
    const ccByIcon = page
      .locator(
        'button:has([data-icon="closed_caption"]), button:has([data-icon="closed_caption_off"])',
      )
      .first();
    if (await ccByIcon.isVisible({ timeout: 2000 })) {
      await ccByIcon.click();
      await page.waitForTimeout(2000);
      if (await checkCaptions()) {
        console.log("  Captions enabled (clicked CC icon)");
        return;
      }
    }
  } catch {
    // Icon not found
  }

  console.log("  WARNING: Could not verify captions are on — capture may not work");
}

/**
 * Caption observer script — injected into the browser context as a string
 * (avoids tsx/esbuild __name transformation issues).
 *
 * Uses the Recall.ai approach:
 * - MutationObserver watches for addedNodes + characterData changes
 * - Speaker name extracted from .NWpY1d / .xoMHSc badge elements
 * - Caption text = element text minus speaker badge text
 * - Calls window.__openutter_onCaption(speaker, text) which bridges to Node.js
 *   via page.exposeFunction
 *
 * Ref: https://www.recall.ai/blog/how-i-built-an-in-house-google-meet-bot
 */
const CAPTION_OBSERVER_SCRIPT = `
(function() {
  var BADGE_SEL = ".NWpY1d, .xoMHSc";
  var captionContainer = null;

  var getSpeaker = function(node) {
    if (!node || !node.querySelector) return "";
    var badge = node.querySelector(BADGE_SEL);
    return badge ? badge.textContent.trim() : "";
  };

  var getText = function(node) {
    if (!node || !node.cloneNode) return "";
    var clone = node.cloneNode(true);
    // Remove speaker badge elements to get just the caption text
    var badges = clone.querySelectorAll ? clone.querySelectorAll(BADGE_SEL) : [];
    for (var i = 0; i < badges.length; i++) badges[i].remove();
    // Also remove img elements (avatars)
    var imgs = clone.querySelectorAll ? clone.querySelectorAll("img") : [];
    for (var j = 0; j < imgs.length; j++) imgs[j].remove();
    return clone.textContent.trim();
  };

  var send = function(node) {
    if (!(node instanceof HTMLElement)) return;

    // Walk up to find a container that has a speaker badge
    var el = node;
    var speaker = "";
    for (var depth = 0; depth < 6 && el && el !== document.body; depth++) {
      speaker = getSpeaker(el);
      if (speaker) break;
      el = el.parentElement;
    }

    if (!speaker || !el) return;

    var text = getText(el);
    if (!text || text.length > 500) return;

    // Filter out system/UI text
    if (/^(mic_off|videocam|call_end|more_vert|keyboard|arrow_)/i.test(text)) return;
    if (text.indexOf("extension") !== -1 && text.indexOf("developers.google") !== -1) return;

    try {
      window.__openutter_onCaption(speaker, text);
    } catch(e) {}
  };

  new MutationObserver(function(mutations) {
    // Lazily find the caption container
    if (!captionContainer || !document.contains(captionContainer)) {
      captionContainer = document.querySelector('[aria-label="Captions"]') ||
                         document.querySelector('[aria-live]');
    }

    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];

      // Only process mutations inside the caption container (if found)
      if (captionContainer && !captionContainer.contains(m.target)) continue;

      // New caption elements added
      var added = m.addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j] instanceof HTMLElement) send(added[j]);
      }

      // Live text updates (word-by-word as speech is recognized)
      if (m.type === "characterData" && m.target && m.target.parentElement) {
        send(m.target.parentElement);
      }
    }
  }).observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true
  });

  console.log("[OpenUtter] Caption observer active");
})();
`;

/**
 * Set up real-time caption capture using page.exposeFunction.
 * Captions flow directly from browser → Node.js via IPC, no polling needed.
 */
/**
 * Normalize text for comparison — lowercase, collapse whitespace, strip punctuation.
 * Google Meet changes capitalization and punctuation mid-stream (e.g. "oh," → "Oh,"),
 * so we need fuzzy matching to detect that text is still growing.
 */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function setupCaptionCapture(
  page: Page,
  transcriptPath: string,
  verbose: boolean,
): Promise<{ cleanup: () => void }> {
  // Track the current in-progress caption per speaker
  const tracking = new Map<string, { text: string; ts: number; startTs: number }>();
  // Track what was already written to disk per speaker, so we never re-write the same content.
  // This is key: Google Meet keeps growing a single caption block for the same speaker,
  // so after we finalize+write, the next mutation still has the full accumulated text.
  // We need to remember what we already wrote to detect genuinely new content.
  const lastWritten = new Map<string, string>();
  let lastMinuteKey = "";

  const finalizeCaption = (speaker: string, text: string, startTs: number): void => {
    // Check if this text was already written (or is a subset of what was written)
    const prevWritten = lastWritten.get(speaker) ?? "";
    const normNew = normalizeForCompare(text);
    const normPrev = normalizeForCompare(prevWritten);

    if (
      normPrev &&
      (normNew === normPrev ||
        normPrev.startsWith(normNew) ||
        (normNew.startsWith(normPrev) && normNew.length - normPrev.length < 5))
    ) {
      // Already written this (or trivially close) — skip
      return;
    }

    // If previous text is a prefix of new text, only write the new portion
    // But for readability, write the full line with timestamp
    lastWritten.set(speaker, text);

    const d = new Date(startTs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const minuteKey = `${hh}:${mm}`;

    // Add a blank line between different minutes for readability
    let prefix = "";
    if (lastMinuteKey && minuteKey !== lastMinuteKey) {
      prefix = "\n";
    }
    lastMinuteKey = minuteKey;

    const line = `[${hh}:${mm}:${ss}] ${speaker}: ${text}`;
    try {
      appendFileSync(transcriptPath, `${prefix}${line}\n`);
    } catch {
      // File write error — ignore
    }
    if (verbose) {
      console.log(`  [caption] ${line}`);
    }
  };

  // Bridge browser → Node.js: called by the MutationObserver in the browser
  await page.exposeFunction("__openutter_onCaption", (speaker: string, text: string) => {
    const existing = tracking.get(speaker);
    const prevWritten = lastWritten.get(speaker) ?? "";

    // Check if this text is just a repeat of what we already wrote
    const normNew = normalizeForCompare(text);
    const normWritten = normalizeForCompare(prevWritten);
    if (normWritten && (normNew === normWritten || normWritten.startsWith(normNew))) {
      // Already wrote this or more — ignore
      return;
    }

    if (existing) {
      const normOld = normalizeForCompare(existing.text);

      // Text is growing (speech in progress) — update without finalizing.
      const isGrowing =
        normNew.startsWith(normOld) ||
        normOld.startsWith(normNew) ||
        (normNew.length > normOld.length &&
          normNew.includes(normOld.slice(0, Math.min(20, normOld.length))));

      if (isGrowing) {
        if (text.length >= existing.text.length) {
          existing.text = text;
          existing.ts = Date.now();
        }
        return;
      }

      // Genuinely different text — finalize the previous caption
      finalizeCaption(speaker, existing.text, existing.startTs);
    }

    // Start tracking new caption
    tracking.set(speaker, { text, ts: Date.now(), startTs: Date.now() });
  });

  // Periodically finalize stale captions (text unchanged for 5s = speech ended).
  const settleInterval = setInterval(() => {
    const now = Date.now();
    for (const [speaker, data] of tracking.entries()) {
      if (now - data.ts >= 5000) {
        finalizeCaption(speaker, data.text, data.startTs);
        tracking.delete(speaker);
      }
    }
  }, 1000);

  // Inject the browser-side MutationObserver
  await page.evaluate(CAPTION_OBSERVER_SCRIPT);

  return {
    cleanup: () => {
      clearInterval(settleInterval);
      // Finalize any remaining captions
      for (const [speaker, data] of tracking.entries()) {
        finalizeCaption(speaker, data.text, data.startTs);
      }
      tracking.clear();
    },
  };
}

// ── main ───────────────────────────────────────────────────────────────
export async function joinMeeting(opts: {
  meetUrl: string;
  headed?: boolean;
  noAuth?: boolean;
  noCamera?: boolean;
  noMic?: boolean;
  verbose?: boolean;
  durationMs?: number;
  botName?: string;
  channel?: string;
  target?: string;
}): Promise<{ context: BrowserContext; page: Page; reason: string }> {
  const {
    meetUrl,
    headed = false,
    noAuth = false,
    noCamera = true,
    noMic = true,
    verbose = false,
    durationMs,
    botName: botNameOpt,
    channel,
    target,
  } = opts;

  // Resolve bot name from config or arg
  let botName = botNameOpt ?? "OpenUtter Bot";
  if (!botNameOpt && existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as { botName?: string };
      if (config.botName) {
        botName = config.botName;
      }
    } catch {
      // Use default
    }
  }

  mkdirSync(OPENUTTER_DIR, { recursive: true });
  mkdirSync(OPENUTTER_WORKSPACE_DIR, { recursive: true });

  console.log(`OpenUtter — Joining meeting: ${meetUrl}`);
  console.log(`  Bot name: ${botName}`);
  console.log(`  Camera: ${noCamera ? "off" : "on"}, Mic: ${noMic ? "off" : "on"}`);
  if (durationMs) {
    console.log(`  Max duration: ${Math.round(durationMs / 60_000)}m`);
  }

  let pw: PlaywrightMod;
  try {
    pw = await import("playwright-core");
  } catch {
    console.error("playwright-core not found. Install it: pnpm add -D playwright-core");
    process.exit(1);
  }

  // Launch browser with fake media devices (no actual camera/mic needed on VM)
  const userDataDir = join(OPENUTTER_DIR, "chrome-profile");
  mkdirSync(userDataDir, { recursive: true });

  const hasAuth = !noAuth && existsSync(AUTH_FILE);
  if (noAuth) {
    console.log("  Joining as guest (--no-auth)");
  } else if (hasAuth) {
    console.log(`  Using saved auth: ${AUTH_FILE}`);
  } else {
    console.log("  No auth.json found — joining as guest (run utter-auth.ts to sign in)");
  }

  const chromiumArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--disable-dev-shm-usage",
    "--window-size=1280,720",
  ];

  // In headless mode, use Chrome's new built-in headless (harder to detect)
  if (!headed) {
    chromiumArgs.push("--headless=new", "--disable-gpu");
  }

  const contextOpts: Record<string, unknown> = {
    headless: true, // We pass --headless=new via args instead
    args: chromiumArgs,
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1280, height: 720 },
    permissions: ["camera", "microphone"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };

  // If auth.json exists, use a non-persistent context with storageState
  // (persistent context + storageState is not supported by Playwright)
  let context: BrowserContext;
  let page: Page;

  if (hasAuth) {
    const browser = await pw.chromium.launch({
      headless: !headed,
      args: chromiumArgs,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    context = await browser.newContext({
      storageState: AUTH_FILE,
      viewport: { width: 1280, height: 720 },
      permissions: ["camera", "microphone"],
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
  } else {
    context = await pw.chromium.launchPersistentContext(userDataDir, contextOpts as any);
    page = context.pages()[0] ?? (await context.newPage());
  }

  // Stealth patches: mask headless indicators before any page loads
  await context.addInitScript(STEALTH_SCRIPT);

  // Navigate to the Google Meet URL and attempt to join.
  // If blocked ("You can't join this video call"), retry with a fresh incognito context.
  const MAX_JOIN_RETRIES = 3;
  let currentContext = context;
  let currentPage = page;
  let joined = false;

  sendMessage({ channel, target, message: `🦦 Connecting to meeting...` });

  for (let attempt = 1; attempt <= MAX_JOIN_RETRIES; attempt++) {
    console.log(`\nNavigating to meeting... (attempt ${attempt}/${MAX_JOIN_RETRIES})`);
    if (attempt > 1) {
      sendMessage({
        channel,
        target,
        message: `🦦 Retrying to join... (attempt ${attempt}/${MAX_JOIN_RETRIES})`,
      });
    }
    await currentPage.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await currentPage.waitForTimeout(3000);

    // Handle overlays and consent screens
    await dismissOverlays(currentPage);

    // Check if Google Meet blocked us
    if (await isBlockedFromJoining(currentPage)) {
      console.warn(`  Blocked: "You can't join this video call" (attempt ${attempt})`);

      if (attempt < MAX_JOIN_RETRIES) {
        // Close the current context and retry with a fresh incognito context
        console.log("  Retrying with fresh incognito browser context...");
        await currentContext.close();

        const browser = await pw.chromium.launch({
          headless: !headed,
          args: chromiumArgs,
          ignoreDefaultArgs: ["--enable-automation"],
        });

        currentContext = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          permissions: ["camera", "microphone"],
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        });

        await currentContext.addInitScript(STEALTH_SCRIPT);
        currentPage = await currentContext.newPage();
        continue;
      }

      // All retries exhausted
      const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "debug-join-failed.png");
      await currentPage.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`[OPENUTTER_DEBUG_IMAGE] ${screenshotPath}`);
      sendImage({
        channel,
        target,
        message: "Blocked from joining after multiple attempts. Here's what the bot saw:",
        mediaPath: screenshotPath,
      });
      await currentContext.close();
      throw new Error(
        `Blocked from joining after ${MAX_JOIN_RETRIES} attempts. Debug screenshot: ${screenshotPath}`,
      );
    }

    // Enter bot name (guest join)
    await enterNameIfNeeded(currentPage, botName);

    // Disable camera and mic on the pre-join page
    await disableMediaOnPreJoin(currentPage, { noCamera, noMic });
    await currentPage.waitForTimeout(1000);

    // Click join button
    console.log("\nAttempting to join...");
    sendMessage({ channel, target, message: `🦦 Asking to join the meeting...` });
    joined = await clickJoinButton(currentPage);

    // Handle 2-step join preview (RecallAI pattern: a second "Join now" may appear)
    if (joined) {
      await currentPage.waitForTimeout(2000);
      try {
        const secondJoin = currentPage.locator('button:has-text("Join now")').first();
        if (await secondJoin.isVisible({ timeout: 2000 })) {
          await secondJoin.click();
          console.log("  Clicked second join button (2-step preview)");
        }
      } catch {
        // No second join button — single-step flow
      }
    }

    // If join button clicked, wait until we're in the meeting (or blocked)
    if (joined) {
      registerScreenshotHandler(currentPage);
      sendMessage({
        channel,
        target,
        message: `🦦 Waiting to be admitted — please ask the host to let "OpenUtter Bot" in`,
      });
      try {
        await waitUntilInMeeting(currentPage);
        break; // Successfully in the meeting
      } catch (err) {
        // Post-join block (e.g. "You can't join this video call" after clicking join)
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Post-join block: ${msg} (attempt ${attempt})`);
        joined = false;
        // Fall through to retry logic below
      }
    }

    // Join button not found or post-join block — retry with fresh context
    if (attempt < MAX_JOIN_RETRIES) {
      console.log(`  Retrying with fresh context... (attempt ${attempt}/${MAX_JOIN_RETRIES})`);
      await currentContext.close();

      const browser = await pw.chromium.launch({
        headless: !headed,
        args: chromiumArgs,
        ignoreDefaultArgs: ["--enable-automation"],
      });

      currentContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        permissions: ["camera", "microphone"],
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });

      await currentContext.addInitScript(STEALTH_SCRIPT);
      currentPage = await currentContext.newPage();
      continue;
    }
  }

  if (!joined) {
    const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "debug-join-failed.png");
    await currentPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error("Could not join the meeting after all attempts.");
    console.error(`[OPENUTTER_DEBUG_IMAGE] ${screenshotPath}`);
    sendImage({
      channel,
      target,
      message: "Could not join the meeting. Here is what the bot saw:",
      mediaPath: screenshotPath,
    });
    await currentContext.close();
    throw new Error(
      `Failed to join after ${MAX_JOIN_RETRIES} attempts. Debug screenshot: ${screenshotPath}`,
    );
  }
  // Take a screenshot to confirm we're in the meeting
  const successScreenshotPath = join(OPENUTTER_WORKSPACE_DIR, "joined-meeting.png");
  await currentPage.screenshot({ path: successScreenshotPath });
  console.log("\n✅ Successfully joined the meeting!");
  console.log(`[OPENUTTER_JOINED] ${meetUrl}`);
  console.log(`[OPENUTTER_SUCCESS_IMAGE] ${successScreenshotPath}`);
  sendImage({
    channel,
    target,
    message: "Successfully joined the meeting!",
    mediaPath: successScreenshotPath,
  });

  // Dismiss post-join dialogs (e.g. "Others may see your video differently" → "Got it")
  await dismissPostJoinDialogs(currentPage);

  // Enable live captions and start transcript capture
  sendMessage({ channel, target, message: `🦦 Enabling live captions...` });
  await enableCaptions(currentPage);

  const meetingId = extractMeetingId(meetUrl);
  const dateStr = new Date().toISOString().slice(0, 10);
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPTS_DIR, `${meetingId}-${dateStr}.txt`);

  const { cleanup: cleanupCaptions } = await setupCaptionCapture(
    currentPage,
    transcriptPath,
    verbose,
  );

  sendMessage({
    channel,
    target,
    message: `🦦 All set! Listening and capturing captions. I'll save the transcript when the meeting ends.`,
  });

  // Wait for meeting to end
  console.log("Waiting in meeting... (Ctrl+C to leave)");
  const reason = await waitForMeetingEnd(currentPage, durationMs);
  console.log(`\nLeaving meeting: ${reason}`);

  // Flush remaining captions
  cleanupCaptions();

  if (existsSync(transcriptPath)) {
    console.log(`[OPENUTTER_TRANSCRIPT] ${transcriptPath}`);
    sendMessage({ channel, target, message: `🦦 Meeting ended (${reason}). Transcript saved.` });
  } else {
    sendMessage({
      channel,
      target,
      message: `🦦 Meeting ended (${reason}). No captions were captured.`,
    });
  }

  return { context: currentContext, page: currentPage, reason };
}

// ── CLI entry ──────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const { context } = await joinMeeting(opts);
  await context.close();
  cleanupPidFile();
  console.log("Done.");
}

const isMain = process.argv[1]?.endsWith("utter-join.ts");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
