// Keeps the immutable client files of recent web builds in every new deploy.
//
// Workers Static Assets serve one file list per Worker version. While a deploy rolls out, a page
// rendered by the old version can ask the new version for its scripts. Without the old files those
// requests answer 404 and the page never hydrates. SvelteKit names immutable files by their
// content, so an old file can never collide with a new one, and carrying them is safe.
//
//   node web-immutable-carry.mjs next <assets dir> <old stash> <new stash> [days]
//     Writes the stash the next deploy will carry: this build's immutable files, plus the old
//     stash's files deployed within the last <days> days (7 by default).
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

/** The stash for the next deploy: this build's files now, older ones while they are recent. */
export function nextStash(
  assets,
  oldStash,
  newStash,
  { now = Date.now(), days = 7 } = {},
) {
  const deployed = new Date(now).toISOString();
  const oldest = now - days * DAY_MS;
  const files = {};
  for (const [name, at] of Object.entries(readLedger(oldStash))) {
    if (Date.parse(at) >= oldest && existsSync(join(oldStash, "files", name)))
      files[name] = at;
  }
  const current = filesUnder(join(assets, IMMUTABLE)).map(
    (name) => `${IMMUTABLE}/${name}`,
  );
  for (const name of current) files[name] = deployed;
  for (const name of Object.keys(files)) {
    const source = current.includes(name)
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
    kept: Object.keys(files).length - current.length,
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
  return { carried };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "next" && args.length >= 3) {
    const days = args[3] === undefined ? 7 : Number(args[3]);
    if (!Number.isInteger(days) || days < 1)
      throw new Error("days must be a whole number");
    const { current, kept } = nextStash(args[0], args[1], args[2], { days });
    console.log(
      `next stash: ${current} files of this build, ${kept} from recent builds`,
    );
  } else if (command === "merge" && args.length === 2) {
    const { carried } = mergeStash(args[0], args[1]);
    console.log(`carried ${carried} immutable files from recent builds`);
  } else {
    console.error(
      "usage: web-immutable-carry.mjs next <assets> <old stash> <new stash> [days]",
    );
    console.error("       web-immutable-carry.mjs merge <old stash> <assets>");
    process.exit(2);
  }
}
