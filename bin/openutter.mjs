#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const skillSourceDir = pkgRoot;
const skillTargetDirDefault = join(homedir(), ".openclaw", "skills", "openutter");
const require = createRequire(import.meta.url);
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

function printHelp() {
  console.log(`OpenUtter

Usage:
  npx openutter
  npx openutter install
  npx openutter auth
  npx openutter join <meet-url> [options]
  npx openutter transcript [--last N]
  npx openutter screenshot

Commands:
  install      Install the OpenUtter skill into ~/.openclaw/skills/openutter
  join         Join a Google Meet and capture captions
  auth         Save a Google session for authenticated joins (optional)
  transcript   Print the latest transcript
  screenshot   Request an on-demand screenshot
  help         Show this help

Examples:
  npx openutter
  npx openutter join https://meet.google.com/abc-defg-hij --anon --bot-name "OpenUtter Bot"
  npx openutter join https://meet.google.com/abc-defg-hij --auth
  npx openutter join https://meet.google.com/abc-defg-hij --auth --headed
  npx openutter auth
  npx openutter transcript --last 20
  npx openutter screenshot

Join options:
  --headed     Show the browser window for debugging
  --duration   Auto-leave after a duration like 30m

Chromium:
  Installed automatically when possible during \`npx openutter\``);
}

function resolveInstallTarget(rawArgs) {
  const idx = rawArgs.indexOf("--target-dir");
  if (idx >= 0) {
    const value = rawArgs[idx + 1];
    if (!value) {
      console.error("Missing value for --target-dir");
      process.exit(1);
    }
    return resolve(value);
  }
  return skillTargetDirDefault;
}

function stripInstallFlags(rawArgs) {
  const next = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    if (rawArgs[i] === "--target-dir") {
      i += 1;
      continue;
    }
    next.push(rawArgs[i]);
  }
  return next;
}

function checkOpenClaw() {
  const result = spawnSync("openclaw", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function runNodeCommand(args, opts = {}) {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    cwd: pkgRoot,
    ...opts,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function runPlaywrightCommand(args) {
  try {
    const playwrightPackageJson = require.resolve("playwright-core/package.json");
    const playwrightCliPath = join(dirname(playwrightPackageJson), "cli.js");
    return runNodeCommand([playwrightCliPath, ...args]);
  } catch {
    const result = spawnSync(npxBin, ["-y", "playwright-core", ...args], {
      stdio: "inherit",
      cwd: pkgRoot,
    });

    if (result.error) {
      throw result.error;
    }

    return result.status ?? 1;
  }
}

function verifyChromiumLaunch() {
  const script = `
    import { chromium } from "playwright-core";
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    console.log("Chromium launch check passed.");
  `;

  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: pkgRoot,
    encoding: "utf8",
  });
}

function isLinuxRoot() {
  return process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
}

function isMissingLinuxRuntimeLib(stderr = "", stdout = "") {
  const output = `${stdout}\n${stderr}`;
  return /error while loading shared libraries|libnspr4\.so|libnss3\.so|libatk-bridge|libxkbcommon|libgbm|libgtk-3/i.test(
    output,
  );
}

function ensureChromiumReady() {
  console.log("Installing Chromium via Playwright...");
  const installCode = runPlaywrightCommand(["install", "chromium"]);
  if (installCode !== 0) {
    console.error("Failed to install Chromium.");
    process.exit(installCode);
  }

  let launchCheck = verifyChromiumLaunch();
  if (launchCheck.status === 0) {
    console.log("Chromium is ready.");
    return;
  }

  if (isMissingLinuxRuntimeLib(launchCheck.stderr, launchCheck.stdout) && process.platform === "linux") {
    console.log("Chromium is installed, but Linux runtime libraries are missing.");

    if (isLinuxRoot()) {
      console.log("Attempting to install Chromium system dependencies...");
      const depsCode = runPlaywrightCommand(["install-deps", "chromium"]);
      if (depsCode !== 0) {
        console.error("Failed to install Linux Chromium dependencies automatically.");
        process.exit(depsCode);
      }

      launchCheck = verifyChromiumLaunch();
      if (launchCheck.status === 0) {
        console.log("Chromium system dependencies installed successfully.");
        return;
      }
    } else {
      console.error("Linux Chromium dependencies are missing and this installer is not running as root.");
      console.error("Run one of these commands, then retry:");
      console.error("  sudo npx playwright-core install-deps chromium");
      console.error("  sudo apt-get update && sudo apt-get install -y libnspr4 libnss3 libatk-bridge2.0-0 libxkbcommon0 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 libcups2 libdrm2 libgbm1 libgtk-3-0 libpango-1.0-0 libpangocairo-1.0-0 libasound2");
      process.exit(1);
    }
  }

  console.error("Chromium launch check failed.");
  if (launchCheck.stderr?.trim()) {
    console.error(launchCheck.stderr.trim());
  } else if (launchCheck.stdout?.trim()) {
    console.error(launchCheck.stdout.trim());
  }
  process.exit(1);
}

function installSkill(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  cpSync(join(skillSourceDir, "SKILL.md"), join(targetDir, "SKILL.md"));
  cpSync(join(skillSourceDir, "scripts"), join(targetDir, "scripts"), { recursive: true });
  ensureChromiumReady();

  console.log(`Installed OpenUtter to ${targetDir}`);
  if (!checkOpenClaw()) {
    console.log("Warning: `openclaw` was not found in PATH. Install OpenClaw before using the skill.");
  }
  console.log("Start a new OpenClaw session to pick it up.");
  console.log("Optional: run `npx openutter auth` if you want authenticated joins.");
}

function runScript(scriptName, args) {
  const scriptPath = join(skillSourceDir, "scripts", scriptName);
  if (!existsSync(scriptPath)) {
    console.error(`Missing script: ${scriptPath}`);
    process.exit(1);
  }

  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];

if (!command || command === "install") {
  installSkill(resolveInstallTarget(rawArgs));
} else if (command === "auth") {
  runScript("utter-auth.ts", rawArgs.slice(1));
} else if (command === "join") {
  runScript("utter-join.ts", rawArgs.slice(1));
} else if (command === "transcript") {
  runScript("utter-transcript.ts", rawArgs.slice(1));
} else if (command === "screenshot") {
  runScript("utter-screenshot.ts", rawArgs.slice(1));
} else if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else {
  const remaining = stripInstallFlags(rawArgs);
  if (remaining.length === 0) {
    installSkill(resolveInstallTarget(rawArgs));
  } else {
    console.error(`Unknown command: ${command}`);
    console.log("");
    printHelp();
    process.exit(1);
  }
}
