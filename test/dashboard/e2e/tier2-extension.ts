// Tier-2 extension prep: ensures the pinned MetaMask build is downloaded,
// unpacked, and patched for automation BEFORE `npx synpress` runs (Synpress
// reuses .cache-synpress content, so whatever is here wins).
//
// The patch: MetaMask 13.13.1's onboarding completion page ("Your wallet is
// ready!") calls chrome.sidePanel.open() when the build's IS_SIDEPANEL flag is
// set — and that call never settles in an automation-driven Chromium, so the
// "Open wallet" button silently does nothing and onboarding can never finish.
// Forcing the flag off takes the classic completion path (which also keeps
// confirmations in popup pages, the UX Synpress automates).
//
// Pinned-exact: the patch asserts the precise 13.13.1 bundle bytes, and the
// Synpress default version is cross-checked below. Any drift fails loudly
// here instead of hanging later in onboarding.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Must match synpress-metamask's DEFAULT_METAMASK_VERSION (cross-checked).
const METAMASK_VERSION = "13.13.1";
const EXTENSION_DIR_NAME = `metamask-chrome-${METAMASK_VERSION}`;
const EXTENSION_ZIP_NAME = `${EXTENSION_DIR_NAME}.zip`;
const DOWNLOAD_URL =
  `https://github.com/MetaMask/metamask-extension/releases/download/v${METAMASK_VERSION}/${EXTENSION_ZIP_NAME}`;

// getIsSidePanelFeatureEnabled with IS_SIDEPANEL baked true (13.13.1 ui bundle).
const FLAG_ON = 'n.getIsSidePanelFeatureEnabled=()=>{var e;if("true"!==(null===(e=!0)?void 0:e.toString()))re';
const FLAG_OFF = FLAG_ON.replace("(e=!0)", "(e=!1)");

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function cacheDir(): string {
  return path.join(REPO_ROOT, ".cache-synpress");
}

function crossCheckSynpressDefault(): void {
  const candidates = [
    "node_modules/@synthetixio/synpress-metamask/src/prepareExtension.ts",
    "node_modules/@synthetixio/synpress-metamask/dist/playwright/index.js",
  ];
  for (const rel of candidates) {
    let text: string;
    try {
      text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      continue;
    }
    const match = text.match(/DEFAULT_METAMASK_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (match) {
      if (match[1] !== METAMASK_VERSION) {
        throw new Error(
          `tier2: Synpress ships MetaMask ${match[1]} but tier2-extension.ts pins ${METAMASK_VERSION}; update the pin and the patch bytes together`,
        );
      }
      return;
    }
  }
  console.warn("tier2: could not cross-check the Synpress MetaMask default; proceeding on the pin");
}

async function downloadZip(zipPath: string): Promise<void> {
  console.log(`tier2: downloading MetaMask ${METAMASK_VERSION}...`);
  const res = await fetch(DOWNLOAD_URL);
  if (!res.ok) throw new Error(`tier2: extension download failed: HTTP ${res.status}`);
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
}

function unzip(zipPath: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  execFileSync("python3", ["-m", "zipfile", "-e", zipPath, outDir], { stdio: "pipe" });
}

function applyPatch(bundlePath: string): void {
  const src = readFileSync(bundlePath, "utf8");
  if (src.includes(FLAG_OFF)) return; // already patched
  if (src.split(FLAG_ON).length - 1 !== 1) {
    throw new Error(
      `tier2: side-panel patch bytes not found exactly once in ${bundlePath}; refusing to guess (MetaMask drift?)`,
    );
  }
  writeFileSync(bundlePath, src.replace(FLAG_ON, FLAG_OFF));
  console.log("tier2: applied the side-panel automation patch");
}

export async function ensurePatchedExtension(): Promise<string> {
  crossCheckSynpressDefault();
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const extDir = path.join(dir, EXTENSION_DIR_NAME);
  const marker = path.join(extDir, ".16ane-sidepanel-patched");
  if (existsSync(marker)) return extDir;
  if (!existsSync(path.join(extDir, "manifest.json"))) {
    const zipPath = path.join(dir, EXTENSION_ZIP_NAME);
    if (!existsSync(zipPath)) await downloadZip(zipPath);
    unzip(zipPath, extDir);
  }
  if (!existsSync(path.join(extDir, "manifest.json"))) {
    throw new Error(`tier2: extension unpack failed (${extDir})`);
  }
  applyPatch(path.join(extDir, "common-12.js"));
  writeFileSync(marker, `${METAMASK_VERSION}\n`);
  return extDir;
}
