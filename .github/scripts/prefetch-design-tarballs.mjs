import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const repository = "yesid-dev/yesid.design";
const releasePrefix = `@https://github.com/${repository}/releases/download/`;

function cacheEntry(integrity) {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error(`Expected a SHA-512 integrity in bun.lock, got ${integrity}`);
  }
  // Bun 1.4.4 keys verified local and remote tarballs by their digest.
  // https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/install/PackageManager/PackageManagerDirectories.rs
  const digest = Buffer.from(integrity.slice("sha512-".length), "base64");
  return `@T@sha512-${digest.subarray(0, 16).toString("hex")}@@@1`;
}

export function cacheTarball(path, integrity, cache) {
  const entry = cacheEntry(integrity);
  const actual = createHash("sha512").update(readFileSync(path)).digest("base64");
  if (`sha512-${actual}` !== integrity) {
    throw new Error(`SHA-512 mismatch against bun.lock for ${path}`);
  }

  const staging = mkdtempSync(join(cache, ".prefetch-"));
  try {
    execFileSync("tar", ["-xzf", path, "--strip-components=1", "-C", staging]);
    if (!existsSync(join(staging, "package.json"))) {
      throw new Error(`Missing package.json in ${path}`);
    }
    renameSync(staging, join(cache, entry));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function prefetch() {
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required to fetch design assets");
  const { packages } = Bun.JSONC.parse(readFileSync("bun.lock", "utf8"));
  const cache = join(homedir(), ".bun", "install", "cache");
  const releases = new Map();

  for (const [resolution, , integrity] of Object.values(packages)) {
    const prefixIndex = resolution.indexOf(releasePrefix);
    if (prefixIndex === -1) continue;
    const path = resolution.slice(prefixIndex + releasePrefix.length);
    const match = /^(v[\w.-]+)\/(yesid-[\w.-]+\.tgz)$/.exec(path);
    if (!match) {
      throw new Error(`Unexpected design release asset in bun.lock: ${path}`);
    }
    const [, tag, asset] = match;
    const assets = releases.get(tag) ?? new Map();
    if (assets.has(asset) && assets.get(asset) !== integrity) {
      throw new Error(`Conflicting bun.lock integrities for ${path}`);
    }
    assets.set(asset, integrity);
    releases.set(tag, assets);
  }

  for (const [tag, assets] of releases) {
    const missing = [...assets].filter(
      ([, integrity]) => !existsSync(join(cache, cacheEntry(integrity), "package.json")),
    );
    if (missing.length === 0) continue;
    const directory = mkdtempSync(join(tmpdir(), "transit-design-release-"));
    try {
      execFileSync(
        "gh",
        [
          "release", "download", tag,
          "--repo", repository,
          "--dir", directory,
          ...missing.flatMap(([asset]) => ["--pattern", asset]),
        ],
        { stdio: "inherit" },
      );
      for (const [asset, integrity] of missing) {
        cacheTarball(join(directory, asset), integrity, cache);
      }
      console.log(`Cached ${missing.length} design tarballs from ${tag} with bun.lock integrity`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) prefetch();
