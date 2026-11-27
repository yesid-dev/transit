import { expect, test } from 'bun:test';
import { recordLayoutViolations } from './lint-design';

test('rejects fixed card gaps and caller-owned name widths', () => {
	const path = 'lib/features/example/Report.svelte';
	const source = `
		<div class="grid md:gap-6">
			<div class="space-y-6"><RecordCard /><RecordCard /></div>
			<RecordDataTable nameWidth="30%" />
		</div>`;
	expect(recordLayoutViolations(path, source)).toEqual([
		`Use gap-(--space-card-gap) between cards in ${path}:2 (gap-6)`,
		`Use gap-(--space-card-gap) between cards in ${path}:3 (space-y-6)`,
		`Let RecordDataTable size its name column in ${path}:4 (nameWidth)`,
	]);
	expect(recordLayoutViolations(path, '<div class="grid gap-(--space-card-gap)" />')).toEqual([]);
});

test('counts each allowed screen departure and requires removal of stale entries', () => {
	const path = 'lib/features/rankings/Rankings.svelte';
	const legacy = '<RecordDataTable nameWidth="40%" />';
	expect(recordLayoutViolations(path, legacy)).toEqual([]);
	expect(recordLayoutViolations(path, `${legacy}\n${legacy}`)).toEqual([
		`Let RecordDataTable size its name column in ${path}:2 (nameWidth)`,
	]);
	expect(recordLayoutViolations(path, '<RecordDataTable />')[0]).toContain('S-fleet');
});
