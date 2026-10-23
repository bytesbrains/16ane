// Tier-2 extension prep: ensures the pinned MetaMask build is downloaded and
// unpacked BEFORE `npx synpress` runs (Synpress skips its own download/unzip
// when .cache-synpress content already exists, so whatever is here wins).
//
// The build is used PRISTINE: an earlier revision patched the bundle's baked
// side-panel flag so onboarding completion would land the tab on the wallet
// home page, but bisecting the snapshot proved the patched bundle walks the
// UI to home while the backend never creates the vault — the cache restored
// as a fresh wallet everywhere. wallet.setup.ts instead hides
// `sidePanel.open` in the onboarding page so the completion click takes
// MetaMask's own non-side-panel path, then waits for the onboarding flag and
// vault to be persisted; do not re-add bundle patching without re-verifying
// the snapshot contains a vault.
//
// Pinned-exact: the Synpress default version is cross-checked below. Any drift
// fails loudly here instead of breaking later in onboarding.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Must match synpress-metamask's DEFAULT_METAMASK_VERSION (cross-checked).
const METAMASK_VERSION = "13.13.1";
const EXTENSION_DIR_NAME = `metamask-chrome-${METAMASK_VERSION}`;
const EXTENSION_ZIP_NAME = `${EXTENSION_DIR_NAME}.zip`;
const DOWNLOAD_URL =
  `https://github.com/MetaMask/metamask-extension/releases/download/v${METAMASK_VERSION}/${EXTENSION_ZIP_NAME}`;

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
          `tier2: Synpress ships MetaMask ${match[1]} but tier2-extension.ts pins ${METAMASK_VERSION}; update the pin together with the setup flow`,
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

// Absolute path, never resolved through PATH; present on macOS and the Ubuntu
// CI runners alike.
const UNZIP = "/usr/bin/unzip";

function unzip(zipPath: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  execFileSync(UNZIP, ["-q", "-o", zipPath, "-d", outDir], { stdio: "pipe" });
}

export async function ensureExtension(): Promise<string> {
  crossCheckSynpressDefault();
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const extDir = path.join(dir, EXTENSION_DIR_NAME);
  if (!existsSync(path.join(extDir, "manifest.json"))) {
    const zipPath = path.join(dir, EXTENSION_ZIP_NAME);
    if (!existsSync(zipPath)) await downloadZip(zipPath);
    unzip(zipPath, extDir);
  }
  if (!existsSync(path.join(extDir, "manifest.json"))) {
    throw new Error(`tier2: extension unpack failed (${extDir})`);
  }
  return extDir;
}
