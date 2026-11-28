// Keeps the immutable client files of recent web builds in every new deploy.
//
// Workers Static Assets serve one file list per Worker version. While a deploy rolls out, a page
// rendered by the old version can ask the new version for its scripts. Without the old files those
// requests answer 404 and the page never hydrates. SvelteKit names immutable files by their
// content, so an old file can never collide with a new one, and carrying them is safe.
//
//   node web-immutable-carry.mjs next <assets dir> <old stash> <new stash>
//     Writes the stash the next deploy will carry: this build's immutable files, plus whole earlier
//     builds, newest first, within CARRY_LIMITS (7 days, 10 builds, 2,000 files).
//   node web-immutable-carry.mjs merge <old stash> <assets dir>
//     Copies the old stash's files that this build lacks into its assets before it deploys.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const IMMUTABLE = "_app/immutable";
const LEDGER = "ledger.json";
const DAY_MS = 86_400_000;
// Workers Free allows 20,000 static asset files per Worker version (Paid: 100,000).
export const MAX_DEPLOYED_FILES = 20_000;

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(root, join(entry.parentPath ?? entry.path, entry.name))
        .split(sep)
        .join("/"),
    );
}

function readLedger(stash) {
  const path = join(stash, LEDGER);
  if (!existsSync(path)) return {};
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof ledger !== "object" ||
    ledger === null ||
    Array.isArray(ledger.files ?? {})
  )
    throw new Error(`${path} is not a ledger`);
  return ledger.files ?? {};
}

function sameBytes(a, b) {
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * Bounds on what a deploy carries. Workers Static Assets allow 20,000 files per Worker version on
 * Workers Free and 100,000 on Paid; one build is about 715 files, 137 of them immutable. The carry
 * stays far below the smaller limit whatever the week's deploy count.
 */
export const CARRY_LIMITS = { days: 7, builds: 10, files: 2_000 };

/**
 * The stash for the next deploy: this build's files, then earlier builds newest first while they
 * were deployed within `days`, number at most `builds` and add at most `files` files. A build is
 * kept or dropped whole, since an old page needs every one of its scripts.
 */
export function nextStash(
  assets,
  oldStash,
  newStash,
  { now = Date.now(), ...limits } = {},
) {
  const { days, builds, files: maxFiles } = { ...CARRY_LIMITS, ...limits };
  const deployed = new Date(now).toISOString();
  const oldest = now - days * DAY_MS;
  const current = filesUnder(join(assets, IMMUTABLE)).map(
    (name) => `${IMMUTABLE}/${name}`,
  );
  const inBuild = new Set(current);
  // Each earlier build: the files whose last deploy it was (a file shared with a newer build
  // belongs to that newer one).
  const earlier = new Map();
  for (const [name, at] of Object.entries(readLedger(oldStash))) {
    if (inBuild.has(name) || !existsSync(join(oldStash, "files", name)))
      continue;
    earlier.set(at, [...(earlier.get(at) ?? []), name]);
  }
  const files = {};
  let keptBuilds = 0;
  let kept = 0;
  let droppedBuilds = 0;
  let droppedFiles = 0;
  for (const [at, names] of [...earlier].sort(
    ([a], [b]) => Date.parse(b) - Date.parse(a),
  )) {
    const fits =
      droppedBuilds === 0 &&
      Date.parse(at) >= oldest &&
      keptBuilds < builds &&
      kept + names.length <= maxFiles;
    if (!fits) {
      droppedBuilds += 1;
      droppedFiles += names.length;
      continue;
    }
    for (const name of names) files[name] = at;
    keptBuilds += 1;
    kept += names.length;
  }
  for (const name of current) files[name] = deployed;
  for (const name of Object.keys(files)) {
    const source = inBuild.has(name)
      ? join(assets, name)
      : join(oldStash, "files", name);
    const target = join(newStash, "files", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  mkdirSync(newStash, { recursive: true });
  writeFileSync(
    join(newStash, LEDGER),
    `${JSON.stringify({ files }, null, 2)}\n`,
  );
  return {
    current: current.length,
    kept,
    keptBuilds,
    droppedBuilds,
    droppedFiles,
  };
}

/** Adds the stash's files this build lacks. A name in both must hold the same bytes. */
export function mergeStash(oldStash, assets) {
  let carried = 0;
  for (const name of Object.keys(readLedger(oldStash))) {
    if (!name.startsWith(`${IMMUTABLE}/`) || name.includes(".."))
      throw new Error(`${name} is not an immutable file`);
    const source = join(oldStash, "files", name);
    if (!existsSync(source)) continue;
    const target = join(assets, name);
    if (existsSync(target)) {
      if (!sameBytes(source, target))
        throw new Error(
          `${name} differs between builds: immutable names must name one content`,
        );
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    carried += 1;
  }
  const total = filesUnder(assets).length;
  if (total > MAX_DEPLOYED_FILES)
    throw new Error(
      `the deployment would hold ${total} files, more than the ${MAX_DEPLOYED_FILES} Workers Static Assets allow`,
    );
  return { carried, total };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "next" && args.length === 3) {
    const { current, kept, keptBuilds, droppedBuilds, droppedFiles } =
      nextStash(...args);
    console.log(
      `next stash: ${current} files of this build, ${kept} from ${keptBuilds} earlier builds; ` +
        `dropped ${droppedFiles} files of ${droppedBuilds} older builds ` +
        `(limits: ${CARRY_LIMITS.days} days, ${CARRY_LIMITS.builds} builds, ${CARRY_LIMITS.files} files)`,
    );
  } else if (command === "merge" && args.length === 2) {
    const { carried, total } = mergeStash(args[0], args[1]);
    console.log(
      `carried ${carried} immutable files from recent builds; the deployment holds ${total} files (limit ${MAX_DEPLOYED_FILES})`,
    );
  } else {
    console.error(
      "usage: web-immutable-carry.mjs next <assets> <old stash> <new stash>",
    );
    console.error("       web-immutable-carry.mjs merge <old stash> <assets>");
    process.exit(2);
  }
}
