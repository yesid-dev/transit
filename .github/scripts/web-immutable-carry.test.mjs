import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CARRY_LIMITS,
  MAX_DEPLOYED_FILES,
  mergeStash,
  nextStash,
} from "./web-immutable-carry.mjs";

const DAY = 86_400_000;
const start = Date.parse("2026-11-20T12:00:00Z");

function build(root, files) {
  mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, "_app/immutable", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  writeFileSync(join(root, "index.html"), "<html></html>");
  return root;
}

const has = (root, name) => existsSync(join(root, "_app/immutable", name));

test("a deploy carries the scripts of recent builds and drops them after a week", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-immutable-"));
  try {
    const a = build(join(root, "a"), {
      "entry/start.AAA.js": "start A",
      "chunks/shared.SSS.js": "shared",
      "nodes/0.AAA.js": "layout A",
    });
    const b = build(join(root, "b"), {
      "entry/start.BBB.js": "start B",
      "chunks/shared.SSS.js": "shared",
      "nodes/0.BBB.js": "layout B",
    });
    const c = build(join(root, "c"), { "entry/start.CCC.js": "start C" });

    // First deploy: nothing to carry yet.
    assert.deepEqual(
      nextStash(a, join(root, "none"), join(root, "s1"), { now: start }),
      { current: 3, kept: 0, keptBuilds: 0, droppedBuilds: 0, droppedFiles: 0 },
    );
    assert.deepEqual(mergeStash(join(root, "none"), a), {
      carried: 0,
      total: 4,
    });

    // A day later, build B also serves build A's scripts; the shared one is not copied twice.
    nextStash(b, join(root, "s1"), join(root, "s2"), { now: start + DAY });
    assert.deepEqual(mergeStash(join(root, "s1"), b), { carried: 2, total: 6 });
    for (const name of [
      "entry/start.AAA.js",
      "nodes/0.AAA.js",
      "entry/start.BBB.js",
    ])
      assert.ok(has(b, name), name);
    assert.equal(
      readFileSync(join(b, "_app/immutable/entry/start.AAA.js"), "utf8"),
      "start A",
    );

    // Nine days after A (eight after B), only files deployed in the last 7 days remain.
    nextStash(c, join(root, "s2"), join(root, "s3"), { now: start + 9 * DAY });
    const ledger = JSON.parse(
      readFileSync(join(root, "s3/ledger.json"), "utf8"),
    ).files;
    assert.deepEqual(Object.keys(ledger), [
      "_app/immutable/entry/start.CCC.js",
    ]);
    // Seven days and an hour after A, six after B: B stays, A goes.
    nextStash(c, join(root, "s2"), join(root, "s3b"), {
      now: start + 7 * DAY + DAY / 24,
    });
    assert.ok(has(join(root, "s3b/files"), "entry/start.BBB.js"));
    assert.ok(!has(join(root, "s3b/files"), "entry/start.AAA.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two builds that disagree on one immutable name stop the deploy", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-immutable-"));
  try {
    const a = build(join(root, "a"), { "chunks/x.XXX.js": "one" });
    const b = build(join(root, "b"), { "chunks/x.XXX.js": "two" });
    nextStash(a, join(root, "none"), join(root, "s1"), { now: start });
    assert.throws(
      () => mergeStash(join(root, "s1"), b),
      /differs between builds/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stash cannot write outside the immutable folder", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-immutable-"));
  try {
    const stash = join(root, "s");
    mkdirSync(join(stash, "files"), { recursive: true });
    writeFileSync(
      join(stash, "ledger.json"),
      JSON.stringify({ files: { "_app/immutable/../../index.html": start } }),
    );
    assert.throws(
      () => mergeStash(stash, build(join(root, "b"), {})),
      /not an immutable file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a busy week carries at most ten earlier builds, newest first, each whole", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-immutable-"));
  try {
    // Twelve deploys an hour apart, each with two scripts of its own.
    let stash = join(root, "none");
    for (let index = 0; index < 12; index += 1) {
      const next = join(root, `s${index}`);
      const deployment = build(join(root, `b${index}`), {
        [`entry/start.${index}.js`]: `start ${index}`,
        [`nodes/0.${index}.js`]: `layout ${index}`,
      });
      nextStash(deployment, stash, next, { now: start + index * (DAY / 24) });
      stash = next;
    }
    const last = build(join(root, "b12"), { "entry/start.12.js": "start 12" });
    const result = nextStash(last, stash, join(root, "s12"), {
      now: start + DAY,
    });
    assert.equal(CARRY_LIMITS.builds, 10);
    // Every deploy caps its stash: build 0 went at the twelfth deploy, build 1 goes now.
    assert.deepEqual(result, {
      current: 1,
      kept: 20,
      keptBuilds: 10,
      droppedBuilds: 1,
      droppedFiles: 2,
    });
    const kept = Object.keys(
      JSON.parse(readFileSync(join(root, "s12/ledger.json"), "utf8")).files,
    );
    assert.ok(kept.includes("_app/immutable/entry/start.11.js"));
    assert.ok(kept.includes("_app/immutable/nodes/0.2.js"));
    assert.ok(!kept.includes("_app/immutable/entry/start.1.js"));
    assert.ok(!kept.includes("_app/immutable/nodes/0.0.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the file cap drops whole builds, and every build older than a dropped one", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-immutable-"));
  try {
    let stash = join(root, "none");
    [3, 4, 2].forEach((count, index) => {
      const next = join(root, `s${index}`);
      const files = Object.fromEntries(
        Array.from({ length: count }, (_, file) => [
          `chunks/${index}-${file}.js`,
          `${index}/${file}`,
        ]),
      );
      nextStash(build(join(root, `b${index}`), files), stash, next, {
        now: start + index * 1000,
      });
      stash = next;
    });
    // Five files allowed: the newest build (2) fits; the next (4) would pass 5, so it and the
    // oldest (3, which alone would fit) are dropped.
    const result = nextStash(
      build(join(root, "now"), {}),
      stash,
      join(root, "capped"),
      {
        now: start + DAY,
        files: 5,
      },
    );
    assert.deepEqual(result, {
      current: 0,
      kept: 2,
      keptBuilds: 1,
      droppedBuilds: 2,
      droppedFiles: 7,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deployment that would pass the static assets file limit stops", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-immutable-"));
  try {
    const assets = build(join(root, "b"), {});
    for (let index = 0; index < MAX_DEPLOYED_FILES; index += 1)
      writeFileSync(join(assets, `f${index}.txt`), "");
    assert.throws(
      () => mergeStash(join(root, "none"), assets),
      /would hold 20001 files, more than the 20000/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
