import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { installUnzip, UNZIP_ARCHIVE } from "./install-layout-unzip.mjs";

const bytes = Buffer.from("authenticated package fixture");
const archive = {
  ...UNZIP_ARCHIVE,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

test("vendored package authenticates locally, including rejection of a mismatched pinned checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "transit-unzip-vendor-"));
  const calls = [];
  try {
    const payload = await readFile(UNZIP_ARCHIVE.path);
    assert.equal(payload.length, UNZIP_ARCHIVE.bytes);
    assert.equal(
      createHash("sha256").update(payload).digest("hex"),
      UNZIP_ARCHIVE.sha256,
    );
    await installUnzip({
      root,
      platform: "linux",
      arch: "x64",
      execute: (...args) => calls.push(args),
    });
    assert.equal(calls[0][0], "dpkg-deb");
    assert.deepEqual(await readFile(calls[0][1][1]), payload);
    await assert.rejects(
      installUnzip({
        root,
        platform: "linux",
        arch: "x64",
        archive: { ...UNZIP_ARCHIVE, sha256: "0".repeat(64) },
        execute: () => assert.fail("unverified package executed"),
      }),
      /authentication failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold setup authenticates before extraction and probes the executable before exposing its path", async () => {
  const root = await mkdtemp(join(tmpdir(), "transit-unzip-test-"));
  const calls = [];
  const fixture = join(root, "fixture.deb");
  await writeFile(fixture, bytes);
  try {
    const bin = await installUnzip({
      root,
      platform: "linux",
      arch: "x64",
      archive: { ...archive, path: fixture },
      execute: (command, args) => {
        calls.push([command, args]);
        return "";
      },
    });
    assert.equal(calls[0][0], "dpkg-deb");
    assert.equal(calls[0][1][0], "--extract");
    assert.deepEqual(await readFile(calls[0][1][1]), bytes);
    assert.ok(!relative(root, bin).startsWith(".."));
    assert.deepEqual(calls[1], [join(bin, "unzip"), ["-v"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bad size or digest cannot extract or execute an archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "transit-unzip-reject-"));
  try {
    const fixture = join(root, "fixture.deb");
    for (const payload of [
      Buffer.from("short"),
      Buffer.alloc(bytes.length),
      Buffer.alloc(bytes.length + 1),
    ]) {
      await writeFile(fixture, payload);
      await assert.rejects(
        installUnzip({
          root,
          platform: "linux",
          arch: "x64",
          archive: { ...archive, path: fixture },
          execute: () => assert.fail("must not extract"),
        }),
        /authentication failed/,
      );
    }
    assert.deepEqual(await readdir(root), ["fixture.deb"]);
    await assert.rejects(
      installUnzip({
        root,
        platform: "win32",
        arch: "x64",
        fetcher: () => assert.fail("must not download"),
      }),
      /Linux x64/,
    );
    await assert.rejects(
      installUnzip({
        root,
        platform: "linux",
        arch: "arm64",
        fetcher: () => assert.fail("must not download"),
      }),
      /Linux x64/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing extraction capability fails rather than hiding setup failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "transit-unzip-capability-"));
  try {
    await assert.rejects(
      installUnzip({
        root,
        platform: "linux",
        arch: "x64",
        archive: UNZIP_ARCHIVE,
        execute: () => {
          throw new Error("dpkg-deb unavailable");
        },
      }),
      /dpkg-deb unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
