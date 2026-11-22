import assert from "node:assert/strict";
import test from "node:test";
import { basename } from "node:path";
import { rollback, workerMissing } from "./worker-rollback.mjs";

const version = "12345678-1234-1234-1234-123456789abc";

test("only a confirmed Cloudflare script-not-found response allows bootstrap", async () => {
  const absent = { success: false, errors: [{ code: 10007 }] };
  const lookup = (status, body) => async (url, options) => {
    assert.match(url, /workers\/scripts\/transit1-web\/script-settings$/);
    assert.equal(options.headers.authorization, "Bearer test-token");
    assert.equal(options.redirect, "error");
    return Response.json(body, { status });
  };
  for (const status of [400, 404]) {
    assert.equal(await workerMissing("test-token", lookup(status, absent)), true);
  }
  assert.equal(await workerMissing("test-token", lookup(200, { success: true })), false);
  for (const [status, body] of [
    [403, absent],
    [404, { success: false, errors: [{ code: 10000 }] }],
    [404, { success: false, errors: [{ code: 10007 }, { code: 10000 }] }],
    [502, absent],
  ]) {
    await assert.rejects(
      workerMissing("test-token", lookup(status, body)),
      /Cannot confirm whether transit1-web exists/,
    );
  }
  await assert.rejects(
    workerMissing("test-token", async () => new Response("not found", { status: 404 })),
    /Cannot confirm whether transit1-web exists/,
  );
  await assert.rejects(
    workerMissing("", () => assert.fail("no token")),
    /Missing Cloudflare token/,
  );
});

test("rollback defaults to previous Worker version and records Wranglers actual version", () => {
  assert.equal(
    rollback("", (_node, args, options) => {
      assert.deepEqual(args.slice(1), ["rollback", "--yes", "--name", "transit1-web"]);
      assert.equal(basename(options.cwd), "web");
      return `Worker Version ${version} has been deployed to 100% of traffic.\nCurrent Version ID: ${version}\n`;
    }),
    version,
  );
});
test("explicit rollback uses an argument array and requires matching confirmation", () => {
  assert.equal(
    rollback(version, (_node, args) => {
      assert.deepEqual(args.slice(1), ["rollback", version, "--yes", "--name", "transit1-web"]);
      return `Current Version ID: ${version}`;
    }),
    version,
  );
  assert.throws(
    () => rollback("--invalid", () => assert.fail("must not execute")),
    /Invalid/,
  );
  assert.throws(() => rollback(version, () => "Cancelled"), /did not confirm/);
  assert.throws(
    () =>
      rollback(
        version,
        () => "Current Version ID: aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      ),
    /did not confirm/,
  );
});
