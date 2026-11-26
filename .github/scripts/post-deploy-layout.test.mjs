import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report, verifyDeployedSha, verifySitePolicy } from "./post-deploy-layout.mjs";

test("post-deploy policy verifies both hosts and checks analytics without sending an event", async () => {
  const canonical = "https://transit.yesid.dev";
  const alias = "https://transit1.yesid.dev";
  const check = ({ relay = 404, extraHtml = "", aliasHeader = "noindex, nofollow", aliasSitemap = false } = {}) =>
    verifySitePolicy(async (url, options) => {
      const { origin, pathname } = new URL(url);
      assert.equal(options.redirect, "error");
      assert.ok([canonical, alias].includes(origin));
      const indexable = origin === canonical;
      if (pathname === "/") {
        assert.equal(options.method, undefined);
        const robots = indexable ? "max-image-preview:large" : "noindex,nofollow";
        const html = `<html><head><link rel="canonical" href="${canonical}/"><link rel="alternate" hreflang="fr" href="${canonical}/fr"><meta name="robots" content="${robots}">${extraHtml}</head></html>`;
        const headers = { "content-type": "text/html" };
        if (!indexable) headers["x-robots-tag"] = aliasHeader;
        return new Response(html, { headers });
      }
      if (pathname === "/robots.txt") {
        return new Response("Allow: /\n" + (indexable ? `Sitemap: ${canonical}/sitemap.xml\n` : ""));
      }
      if (pathname === "/sitemap.xml") {
        return new Response(indexable || aliasSitemap ? `<urlset><loc>${canonical}/</loc></urlset>` : "<urlset/>");
      }
      assert.equal(url, alias + "/relay/e");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {});
      return new Response(null, { status: relay });
    });
  await check();
  await assert.rejects(check({ relay: 400 }), /disabled transit1 analytics relay/);
  for (const src of ["https://static.cloudflareinsights.com/beacon.min.js", "/cdn-cgi/rum"]) {
    await assert.rejects(check({ extraHtml: `<script src="${src}"></script>` }), /Cloudflare Web Analytics beacon/);
  }
  await assert.rejects(check({ aliasHeader: "index" }), /Unexpected Transit indexing header/);
  await assert.rejects(check({ aliasSitemap: true }), /Unexpected Transit robots or sitemap policy/);
});

test("layout replay verifies that production reports the intended source SHA", async () => {
  const sha = "a".repeat(40);
  const fetcher = async () => ({
    status: 200,
    json: async () => ({ service: "transit1-web", commit: sha }),
  });
  await verifyDeployedSha(sha, fetcher);
  await assert.rejects(
    verifyDeployedSha("b".repeat(40), fetcher, fakeClock()),
    /does not report/,
  );
});

function fakeClock() {
  let time = 0;
  const sleeps = [];
  const logs = [];
  return {
    deadlineMs: 5_000,
    intervalMs: 3_000,
    sleeps, logs,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    log: (line) => logs.push(line),
  };
}

const health = (commit) => ({
  status: 200,
  json: async () => ({ service: "transit1-web", commit }),
});

test("waits until production reports the deployed commit", async () => {
  const sha = "a".repeat(40);
  const clock = fakeClock();
  let reads = 0;
  await verifyDeployedSha(sha, async () => health(++reads < 3 ? "b".repeat(40) : sha), clock);
  assert.equal(reads, 3);
  assert.deepEqual(clock.sleeps, [3_000, 3_000]);
  assert.equal(clock.logs.length, 3);
  assert.match(clock.logs[2], /6s/);
});

test("a newly attached domain gets a longer window to report the deploy", async () => {
  const sha = "a".repeat(40);
  for (const waitForDomain of [false, true]) {
    const { deadlineMs, ...clock } = fakeClock();
    let reads = 0;
    const verifies = verifyDeployedSha(sha, async () => {
      reads++;
      return clock.now() >= 120_000 ? health(sha) : new Response(null, { status: 502 });
    }, { ...clock, waitForDomain });
    if (waitForDomain) {
      await verifies;
      assert.equal(clock.now(), 120_000);
    } else {
      await assert.rejects(verifies, /waited 90s/);
    }
    assert.equal(reads, clock.sleeps.length + 1);
  }
});

test("a read that fails is not the end", async () => {
  const sha = "a".repeat(40);
  const clock = fakeClock();
  let reads = 0;
  await verifyDeployedSha(sha, async () => {
    if (++reads === 1) throw new Error("unavailable");
    return health(sha);
  }, clock);
  assert.equal(reads, 2);
  assert.deepEqual(clock.sleeps, [3_000]);
  assert.match(clock.logs[0], /nothing/);
});

test("fails when the deadline passes", async () => {
  const sha = "a".repeat(40);
  const previous = "b".repeat(40);
  const clock = fakeClock();
  const readTimes = [];
  await assert.rejects(verifyDeployedSha(sha, async () => {
    readTimes.push(clock.now());
    return health(previous);
  }, clock), (error) => {
    assert.match(error.message, /^Production Worker does not report the deployed source SHA/);
    assert.ok(error.message.includes(sha));
    assert.ok(error.message.includes(previous));
    assert.match(error.message, /6s/);
    return true;
  });
  await Promise.resolve();
  assert.deepEqual(readTimes, [0, 3_000, 6_000]);
  assert.deepEqual(clock.sleeps, [3_000, 3_000]);
});

test("an invalid commit fails at once", async () => {
  for (const sha of [undefined, "a".repeat(39), "A".repeat(40), "g".repeat(40)]) {
    const clock = fakeClock();
    let reads = 0;
    await assert.rejects(verifyDeployedSha(sha, async () => { reads++; }, clock),
      /^Error: Production Worker does not report the deployed source SHA$/);
    assert.equal(reads, 0);
    assert.deepEqual(clock.sleeps, []);
  }
});

test("a seeded failure opens the shared alert and records the rollback command; recovery resolves it", () => {
  const directory = mkdtempSync(join(tmpdir(), "transit-post-layout-"));
  try {
    const env = {
      GH_REPO: "yesid-dev/transit",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      DEPLOY_RESULT: "success",
      ROLLBACK_VERSION: "12345678-1234-1234-1234-123456789abc",
      LAYOUT_RESULT: "failure",
      GITHUB_STEP_SUMMARY: join(directory, "summary"),
    };
    const calls = [];
    const execute = (command, args) => {
      calls.push([command, args]);
      return "";
    };
    assert.throws(() => report(env, execute), /alert published/);
    assert.equal(calls[0][0], "bash");
    assert.deepEqual(calls[0][1].slice(1, 3), ["fire", "layout-123-1"]);
    assert.ok(calls[0][1].at(-1).includes(env.GITHUB_SHA));
    assert.match(
      readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
      /gh workflow run rollback.yml -R yesid-dev\/transit --ref main/,
    );
    report({ ...env, LAYOUT_RESULT: "success" }, execute);
    assert.deepEqual(calls[1][1].slice(1, 3), ["resolve", "layout-123-1"]);
    assert.throws(
      () =>
        report(env, (command, args) => {
          if (command === "bash")
            return "alert-issue: issue #42 already open for alert:layout-123-1; leaving as-is.";
          assert.deepEqual(args.slice(0, 3), ["issue", "comment", "42"]);
          return "";
        }),
      /alert published/,
    );
    assert.throws(
      () =>
        report(env, () => {
          throw new Error("alert transport failed");
        }),
      /alert transport failed/,
    );
    assert.throws(
      () => report({ ...env, ROLLBACK_VERSION: "" }, execute),
      /alert published$/,
    );
    assert.match(calls.at(-1)[1].at(-1), /No pre-deployment Worker version was captured/);
    assert.doesNotMatch(calls.at(-1)[1].at(-1), /gh workflow run rollback/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
