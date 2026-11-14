import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import test from "node:test";

const candidates = process.platform === "win32"
  ? [join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe"), "bash"]
  : ["bash"];
const bash = candidates.find((candidate) =>
  spawnSync(candidate, ["-c", "exit 0"], { timeout: 5000 }).status === 0,
);
const options = { skip: bash ? false : "Native Bash unavailable; Linux CI proof required" };
const smoke = readFileSync(new URL("../smoke.sh", import.meta.url), "utf8");

function probe(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "transit-smoke-default-"));
  t.after(() => {
    const owned = relative(tmpdir(), directory);
    assert.ok(owned && !owned.startsWith("..") && !isAbsolute(owned));
    rmSync(directory, { recursive: true, force: true });
  });
  const provider = overrides.provider || "third";
  const fixture = {
    provider, base: "/root", catalogue: { default_provider: provider, providers: [{ id: "stm" }, { id: provider }] },
    manifest: { provider, files: { static: { basemap: "static/map-description.json" } } },
    descriptor: { url: `/data/v1/${provider}/static/basemap/unrelated.pmtiles` }, ...overrides,
  };
  for (const key of ["catalogue", "manifest", "descriptor"]) {
    const body = fixture[key];
    writeFileSync(join(directory, `${key}.json`), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  writeFileSync(join(directory, "smoke.sh"), smoke);
  writeFileSync(join(directory, "curl"), String.raw`#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
method=GET
status_only=false
headers=false
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  case "$arg" in -*I*) method=HEAD; headers=true ;; esac
  [ "$arg" != '-D' ] || headers=true
  [ "$arg" != '-w' ] || status_only=true
  if [ "$arg" = '-X' ]; then next=$((i+1)); method="\${!next}"; fi
done
printf '%s\t' "$method" "$url" "$@" >> transcript
printf '\n' >> transcript
case "$url" in
  "https://canonical.test$TEST_BASE"/*) host=canonical; path="\${url#https://canonical.test$TEST_BASE}" ;;
  "https://fallback.test$TEST_BASE"/*) host=fallback; path="\${url#https://fallback.test$TEST_BASE}" ;;
  "https://apex.test$TEST_BASE"/*) host=apex; path="\${url#https://apex.test$TEST_BASE}" ;;
  *) exit 97 ;;
esac
p="/v1/$TEST_PROVIDER"
case "$path" in
  "$p/manifest.json"|"$p/static/map-description.json"|"$p/static/basemap/unrelated.pmtiles"|"$p/live/vehicles.json"|"$p/static/routes_index.json"|"$p/historic/network_trend.json"|"$p/provenance.json"|"$p/definitely-missing.json"|/v1/providers.json|/secrets.txt|/api/v1/kpis|/api/v1/definitely-missing|/api/vitals) ;;
  /v1/sto/static/routes_index.json|/v1%2Fsto/static/routes_index.json|/%761%2Fsto/static/routes_index.json|/v1/sto%2Fstatic/routes_index.json|/v1/%73to/static/routes_index.json) ;;
  *) exit 97 ;;
esac
status=200
case "$path" in
  *sto*|*%73to*) [ "$host" != canonical ] && status=410 || status=404 ;;
  *definitely-missing*|/secrets.txt) status=404 ;;
  *) if [ "$method" = POST ]; then [ "$path" = /api/vitals ] && status=400 || status=405; fi ;;
esac
[ "$method" != OPTIONS ] || status=204
if [ "$status_only" = true ]; then printf '%s' "$status"; exit; fi
cache='public, max-age=86400'
case "$path" in
  *definitely-missing*|/api/*) cache=no-store ;;
  */manifest.json|*/live/vehicles.json) cache='public, max-age=20' ;;
  */static/routes_index.json) cache='public, max-age=604800' ;;
esac
if [ "$headers" = true ]; then
  printf 'HTTP/2 %s\r\ncontent-type: application/json\r\ncache-control: %s\r\naccess-control-allow-origin: *\r\n' "$status" "$cache"
  [ "$status" = 404 ] || printf 'cf-cache-status: HIT\r\nage: 2\r\n'
  printf 'access-control-allow-methods: GET, HEAD\r\naccess-control-allow-headers: range\r\n\r\n'
else
  case "$path" in
    /v1/providers.json) [ "$TEST_UNAVAILABLE" != true ] || exit 22; cat catalogue.json ;;
    "$p/manifest.json") cat manifest.json ;;
    "$p/static/map-description.json") cat descriptor.json ;;
    /api/v1/kpis) printf '%s' '{"snapshotAt":"now","freshnessS":1,"vehicles":1,"avgDelayS":0,"coverage":1,"routesLive":1,"routesTotal":1,"topRoutes":[]}' ;;
    *) exit 97 ;;
  esac
fi
`.replaceAll("\\${", "${"), { mode: 0o755 });
  const result = spawnSync(bash, ["-c", 'export PATH="$PWD:$PATH"\nbash ./smoke.sh'], {
    cwd: directory, encoding: "utf8", timeout: 30000,
    env: { ...process.env, CANONICAL_BASE: `https://canonical.test${fixture.base}`,
      FALLBACK_BASE: `https://fallback.test${fixture.base}`, APEX_BASE: `https://apex.test${fixture.base}`,
      TEST_PROVIDER: provider, TEST_BASE: fixture.base, TEST_UNAVAILABLE: String(Boolean(fixture.unavailable)), BROWSER_ORIGIN: "https://browser.test", EDGE_RETRY_DELAY_S: "0", KPIS_RETRY_DELAY_S: "0" },
  });
  assert.ifError(result.error);
  const transcript = readFileSync(join(directory, "transcript"), "utf8").trim().split("\n").map(line => { const [method, url, ...args] = line.split("\t"); return { method, url, args }; });
  return { ...result, transcript };
}

test("smoke follows a non-STM catalogue default and its published basemap pointer", options, (t) => {
  const result = probe(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SMOKE OK/);
  assert.deepEqual(result.transcript.map(r => [r.method, r.url]), expectedTranscript("third"));
  assert.ok(result.transcript.some(r => r.method === "OPTIONS" && r.url === "https://canonical.test/root/v1/third/static/basemap/unrelated.pmtiles"));
  assert.ok(result.transcript.every(r => !r.url.includes("/stm/")));
});

// Independent literal route sequence: metadata, the established gates, then KPI.
function expectedTranscript(provider) {
  return [
    ["GET", "canonical", "/v1/providers.json"],
    ["GET", "canonical", `/v1/${provider}/manifest.json`],
    ["GET", "canonical", `/v1/${provider}/static/map-description.json`],
    ["HEAD", "canonical", `/v1/${provider}/manifest.json`],
    ["GET", "canonical", `/v1/${provider}/manifest.json`],
    ["OPTIONS", "canonical", `/v1/${provider}/static/basemap/unrelated.pmtiles`],
    ...Array(2).fill(["GET", "canonical", `/v1/${provider}/definitely-missing.json`]),
    ...["/v1/sto/", "/v1%2Fsto/", "/%761%2Fsto/", "/v1/sto%2F", "/v1/%73to/"].map(p => ["GET", "canonical", `${p}static/routes_index.json`]),
    ...["live/vehicles.json", "static/routes_index.json", "historic/network_trend.json", "provenance.json"].map(p => ["HEAD", "canonical", `/v1/${provider}/${p}`]),
    ["GET", "fallback", `/v1/${provider}/definitely-missing.json`],
    ["HEAD", "fallback", `/v1/${provider}/definitely-missing.json`],
    ["GET", "fallback", "/secrets.txt"],
    ["POST", "fallback", `/v1/${provider}/manifest.json`],
    ["GET", "fallback", `/v1/${provider}/manifest.json`],
    ...["/v1/sto/", "/v1%2Fsto/", "/v1/sto%2F", "/v1/%73to/"].map(p => ["GET", "fallback", `${p}static/routes_index.json`]),
    ["GET", "apex", "/api/v1/kpis"], ["HEAD", "apex", "/api/v1/kpis"],
    ["GET", "apex", "/api/v1/definitely-missing"], ["POST", "apex", "/api/vitals"],
  ].map(([method, host, path]) => [method, `https://${host}.test/root${path}`]);
}

test("STM smoke keeps the established probes and adds only metadata discovery reads", options, (t) => {
  const result = probe(t, { provider: "stm", catalogue: { default_provider: "stm", providers: [{ id: "other" }, { id: "stm" }] } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.transcript.map(r => [r.method, r.url]), expectedTranscript("stm"));
  const edge = result.transcript[4], range = result.transcript[5];
  assert.ok(edge.args.includes("Origin: https://browser.test"));
  assert.ok(range.args.includes("Access-Control-Request-Headers: range"));
  assert.ok(range.args.includes("Access-Control-Request-Method: GET"));
});

for (const [name, overrides, diagnostic, reads] of [
  ["unavailable catalogue", { unavailable: true }, "catalogue_unavailable", 1],
  ["malformed catalogue", { catalogue: "{" }, "catalogue_invalid", 1],
  ["bad member list", { catalogue: {} }, "catalogue_invalid", 1],
  ...[undefined, "", null, 12].map(value => ["missing default " + value, { catalogue: { default_provider: value, providers: [{ id: "third" }] } }, "default_provider_missing", 1]),
  ["unknown default", { catalogue: { default_provider: "unknown", providers: [{ id: "third" }] } }, "default_provider_unknown", 1],
  ["duplicate default", { catalogue: { default_provider: "third", providers: [{ id: "third" }, { id: "third" }] } }, "default_provider_unknown", 1],
  ["wrong manifest identity", { manifest: { provider: "stm" } }, "manifest_provider_mismatch", 2],
  ["missing basemap pointer", { manifest: { provider: "third" } }, "basemap_pointer_missing", 2],
  ["malformed manifest", { manifest: "{" }, "snapshot_pointer_invalid", 2],
  ["missing tile pointer", { descriptor: {} }, "basemap_pointer_missing", 3],
  ["malformed descriptor", { descriptor: "{" }, "snapshot_pointer_invalid", 3],
]) {
  test(`smoke refuses ${name} before dependent probes`, options, (t) => {
    const result = probe(t, overrides);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`FAIL: ${diagnostic}`));
    assert.equal(result.transcript.length, reads);
    assert.ok(result.transcript.every(r => !r.url.includes("/stm/")));
  });
}

for (const pointer of ["https://foreign.test/v1/third/map.json", "/v1/stm/map.json", "../map.json", "static/%2e%2e/map.json", "static/a%2fb.json", "static/a\\b.json", "https://user:password@canonical.test/v1/third/map.json", "static/wrong.pmtiles", "", 42]) {
  test(`smoke refuses unsafe descriptor pointer ${String(pointer)}`, options, (t) => {
    const result = probe(t, { manifest: { provider: "third", files: { static: { basemap: pointer } } } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FAIL: (snapshot_pointer_invalid|basemap_pointer_missing)/);
    assert.equal(result.transcript.length, 2);
  });
}

for (const pointer of ["https://foreign.test/v1/third/tile.pmtiles", "/v1/stm/tile.pmtiles", "../tile.pmtiles", "/data/v1/third/%2ftile.pmtiles", "static/wrong.json"]) {
  test(`smoke refuses unsafe tile pointer ${pointer}`, options, (t) => {
    const result = probe(t, { descriptor: { url: pointer } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FAIL: snapshot_pointer_invalid/);
    assert.equal(result.transcript.length, 3);
  });
}

for (const [descriptor, tile] of [
  ["static/map-description.json", "basemap/unrelated.pmtiles"],
  ["/v1/third/static/map-description.json", "/v1/third/static/basemap/unrelated.pmtiles"],
  ["/data/v1/third/static/map-description.json", "/data/v1/third/static/basemap/unrelated.pmtiles"],
  ["https://canonical.test/v1/third/static/map-description.json", "https://canonical.test/data/v1/third/static/basemap/unrelated.pmtiles"],
  ["https://canonical.test/root/v1/third/static/map-description.json", "https://canonical.test/root/v1/third/static/basemap/unrelated.pmtiles"],
]) {
  test(`smoke resolves published pointer forms ${descriptor}`, options, (t) => {
    const result = probe(t, { manifest: { provider: "third", files: { static: { basemap: descriptor } } }, descriptor: { url: tile } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.transcript.map(r => [r.method, r.url]), expectedTranscript("third"));
  });
}
