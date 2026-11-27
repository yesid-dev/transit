import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The updater's Linux build must work from archived inputs with no workspace install.
const bun = execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
const release = mkdtempSync(join(tmpdir(), 'transit-warm-release-'));
const runner = join(release, 'apps/web/scripts/warm-default-views.ts');
const stub = join(release, 'public-catalog.mjs');
try {
  execFileSync('bash', ['apps/engine/ops/linux/build-warm-runner.sh', 'HEAD', bun, runner], {
    stdio: 'inherit',
  });
  writeFileSync(stub, `
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-11-27T12:00:00Z'])); }
    };
    globalThis.fetch = async (url) => {
      if (String(url) !== 'https://data.yesid.dev/v2/cities') {
        throw new Error('Unexpected request in the archive smoke test');
      }
      return Response.json({ providers: [
        { id: 'first', timezone: 'America/Toronto', record_through: '2026-11-25', inputs: {} },
        { id: 'second', timezone: 'America/Toronto', record_through: '2026-11-25', inputs: {} },
      ] });
    };
  `);
  const urls = execFileSync(bun, ['--no-install', '--preload', stub, runner, '--dry-run'], {
    cwd: release, encoding: 'utf8',
  }).trim().split('\n').map((url) => new URL(url));
  assert.equal(new Set(urls.map(String)).size, urls.length);
  assert.equal(urls.filter(({ pathname }) => pathname === '/v2/how-we-measure').length, 1);
  const defaults = [];
  const followUps = [];
  for (const city of ['first', 'second']) {
    const health = (from) => urls.findIndex(({ pathname, searchParams }) =>
      pathname === `/v2/${city}/data-health` && searchParams.get('from') === from &&
      searchParams.get('to') === '2026-11-25');
    defaults.push(health('2026-11-19'));
    followUps.push(health('2026-10-29'), health('2026-11-01'));
  }
  assert.ok(defaults.every((index) => index >= 0), 'both default periods are present');
  assert.ok(followUps.every((index) => index > Math.max(...defaults)), 'both defaults run first');
} finally {
  rmSync(release, { recursive: true, force: true });
}
