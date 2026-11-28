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
import { mergeStash, nextStash } from "./web-immutable-carry.mjs";

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
      {
        current: 3,
        kept: 0,
      },
    );
    assert.deepEqual(mergeStash(join(root, "none"), a), { carried: 0 });

    // A day later, build B also serves build A's scripts; the shared one is not copied twice.
    nextStash(b, join(root, "s1"), join(root, "s2"), { now: start + DAY });
    assert.deepEqual(mergeStash(join(root, "s1"), b), { carried: 2 });
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
