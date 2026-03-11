#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const skillSourceDir = pkgRoot;
const skillTargetDirDefault = join(homedir(), ".openclaw", "skills", "openutter");

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
  npx playwright-core install chromium`);
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

function installSkill(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  cpSync(join(skillSourceDir, "SKILL.md"), join(targetDir, "SKILL.md"));
  cpSync(join(skillSourceDir, "scripts"), join(targetDir, "scripts"), { recursive: true });

  console.log(`Installed OpenUtter to ${targetDir}`);
  if (!checkOpenClaw()) {
    console.log("Warning: `openclaw` was not found in PATH. Install OpenClaw before using the skill.");
  }
  console.log("Start a new OpenClaw session to pick it up.");
  console.log("If needed, install Chromium with: npx playwright-core install chromium");
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
