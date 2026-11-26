import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertLoopback,
  engineBinding,
  localLiveResponse,
  previewCityList,
  publishDeclaration,
  sameOriginCatalog,
  writePreviewDeclarations,
} from "../scripts/private-preview.mjs";

const PRIVATE = `provider:
  provider_id: gamma
  is_active: false
public:
  enabled: false
  labels:
    en: {city: Gamma, operator: GT}
capture_enabled: true
feeds:
  trip_updates:
    is_enabled: true
`;

test("refuses anything but this computer", () => {
  for (const url of ["http://127.0.0.1:4417", "http://localhost:1", "http://[::1]:8790"]) {
    assert.equal(assertLoopback(url), url);
  }
  for (const url of ["http://0.0.0.0:4417", "https://data.yesid.dev", "http://192.168.1.5:80"]) {
    assert.throws(() => assertLoopback(url), /only talks to this computer/);
  }
  assert.throws(() => engineBinding("https://transit-engine.example"), /only talks/);
});

test("previews the public cities plus only the named one", () => {
  const declarations = {
    alpha: { provider: { is_active: true }, public: { enabled: true } },
    beta: { stage: "public" },
    gamma: { provider: { is_active: false }, public: { enabled: false } },
    delta: { stage: "capturing" },
  };
  assert.deepEqual([...previewCityList(declarations, "gamma")].sort(), ["alpha", "beta", "gamma"]);
  assert.throws(() => previewCityList(declarations, "omega"), /No declaration/);
});

test("switches only the named declaration's publication flags", () => {
  assert.equal(
    publishDeclaration(PRIVATE),
    PRIVATE.replace("  is_active: false", "  is_active: true").replace(
      "  enabled: false", "  enabled: true"),
  );
  assert.match(publishDeclaration("declaration: 2\nstage: capturing\n"), /^stage: public$/m);
  assert.throws(() => publishDeclaration("provider:\n  provider_id: x\n"), /Unexpected/);

  const source = mkdtempSync(join(tmpdir(), "preview-source-"));
  const target = join(mkdtempSync(join(tmpdir(), "preview-target-")), "providers");
  writeFileSync(join(source, "gamma.yaml"), PRIVATE);
  writeFileSync(join(source, "delta.yaml"), "declaration: 2\nstage: capturing\n");
  writeFileSync(join(source, "default-city.txt"), "alpha\n");
  writePreviewDeclarations(source, target, "gamma");
  assert.match(readFileSync(join(target, "gamma.yaml"), "utf8"), /is_active: true/);
  assert.equal(readFileSync(join(target, "delta.yaml"), "utf8"), "declaration: 2\nstage: capturing\n");
  assert.equal(readFileSync(join(target, "default-city.txt"), "utf8"), "alpha\n");
  assert.equal(readFileSync(join(source, "gamma.yaml"), "utf8"), PRIVATE);
});

test("serves the local publisher's live objects with R2's range and ETag rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-live-"));
  mkdirSync(join(dir, "live", "v2", "gamma"), { recursive: true });
  const bundle = Buffer.from("[1,2][3,4]");
  writeFileSync(join(dir, "live", "v2", "gamma", "trips.bin"), bundle);
  const etag = `"${createHash("md5").update(bundle).digest("hex")}"`;

  const part = localLiveResponse(dir, "gamma", "live/v2/gamma/trips.bin", "GET",
    new Headers({ range: "bytes=5-9", "if-match": etag }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 5-9/10");
  assert.equal(await part.text(), "[3,4]");
  assert.equal(localLiveResponse(dir, "gamma", "live/v2/gamma/trips.bin", "GET",
    new Headers({ "if-match": '"stale"' })).status, 412);
  assert.equal(localLiveResponse(dir, "gamma", "live/v2/gamma.json", "GET", new Headers()).status,
    404);
  assert.equal(localLiveResponse(dir, "gamma", "live/v2/alpha.json", "GET", new Headers()), null);
  assert.equal(localLiveResponse(dir, "gamma", "alpha/2026-06-01/v12/manifest.json", "GET",
    new Headers()), null);
});

test("points public tile addresses at the preview origin", () => {
  const body = JSON.stringify({
    providers: [
      { id: "alpha", basemap_v2_url: "https://data.yesid.dev/v2/alpha/basemap/alpha.pmtiles" },
      { id: "beta", basemap_v2_url: null },
    ],
  });
  assert.deepEqual(JSON.parse(sameOriginCatalog(body)).providers.map((p) => p.basemap_v2_url), [
    "/v2/alpha/basemap/alpha.pmtiles",
    null,
  ]);
});
