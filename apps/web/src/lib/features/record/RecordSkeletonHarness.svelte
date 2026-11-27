<script lang="ts" module>
	import type { RecordWaiting } from './recordWaiting.ts';

	/** Every shape of the skeleton spec (D3), with the counts the screens will pass. */
	export const harnessShapes: { label: string; waiting: RecordWaiting }[] = [
		{ label: 'answer', waiting: 'answer' },
		{ label: 'answer, comparison line', waiting: { shape: 'answer', comparison: true } },
		{ label: 'reading', waiting: 'reading' },
		{ label: 'facts (4)', waiting: { shape: 'facts', count: 4 } },
		{ label: 'trip-facts', waiting: 'trip-facts' },
		{ label: 'bands', waiting: 'bands' },
		{ label: 'band-comparison', waiting: 'band-comparison' },
		{ label: 'trend', waiting: 'trend' },
		{ label: 'histogram', waiting: 'histogram' },
		{ label: 'table (7 rows)', waiting: { shape: 'table', rows: 7 } },
		{ label: 'rows (8, two lines, plate)', waiting: { shape: 'rows', count: 8 } },
		{
			label: 'rows (3, one line, plate)',
			waiting: { shape: 'rows', count: 3, lines: 1, header: false },
		},
		{ label: 'rows (5, two lines, no lead)', waiting: { shape: 'rows', count: 5, lead: 'none' } },
		{
			label: 'rows (4, one line, code)',
			waiting: { shape: 'rows', count: 4, lines: 1, lead: 'code' },
		},
		{ label: 'grid', waiting: 'grid' },
		{ label: 'ladder (47 stops)', waiting: { shape: 'ladder', count: 47 } },
		{ label: 'ladder (6 stops)', waiting: { shape: 'ladder', count: 6 } },
		{ label: 'notice (2)', waiting: { shape: 'notice', count: 2 } },
		{ label: 'card', waiting: 'card' },
		{ label: 'line', waiting: 'line' },
	];
</script>

<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordCard from './RecordCard.svelte';
	import RecordGroup from './RecordGroup.svelte';
	import RecordPending from './RecordPending.svelte';
	import RecordSkeleton from './RecordSkeleton.svelte';
	import { skeletonBlockSize } from './recordWaiting.ts';

	let { locale = 'en' }: { locale?: Locale } = $props();

	function expected(waiting: RecordWaiting) {
		const size = skeletonBlockSize(waiting);
		const rem = size?.match(/^([\d.]+)rem$/)?.[1];
		return rem ? `${Number(rem) * 16} px` : 'follows the layout';
	}
</script>

<div class="harness" data-slot="skeleton-harness">
	<RecordGroup aria-label="Record skeleton shapes">
		<div class="shapes">
			{#each harnessShapes as { label, waiting } (label)}
				<!-- An answer spans the screen's column, as it does on every Record screen. -->
				<div class="grid min-w-0" class:wide={label.startsWith('answer')}>
					<RecordCard title={label} stamp={{ kind: 'record', label: expected(waiting) }}>
						<div data-harness-shape={label}>
							<RecordPending {locale} shape={waiting} />
						</div>
					</RecordCard>
				</div>
			{/each}
			<RecordCard title="busy, rows (3, two lines)" stamp={{ kind: 'record', label: 'busy' }}>
				<div data-harness-shape="busy">
					<RecordPending {locale} busy shape={{ shape: 'rows', count: 3 }} />
				</div>
			</RecordCard>
			<RecordCard title="card shell, facts (2)" waiting={{ shape: 'facts', count: 2 }}>
				<span></span>
			</RecordCard>
		</div>
	</RecordGroup>
	<RecordGroup aria-label="Record skeleton tiles">
		<div data-harness-shape="tiles (4, small)">
			<RecordSkeleton shape={{ shape: 'tiles', count: 4 }} />
		</div>
		<div data-harness-shape="tiles (2, file)">
			<RecordSkeleton shape={{ shape: 'tiles', count: 2, size: 'file' }} />
		</div>
	</RecordGroup>
</div>

<style>
	.harness {
		display: grid;
		gap: var(--space-card-gap);
	}
	.shapes {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 26rem), 1fr));
		align-items: start;
		gap: var(--space-card-gap);
	}
	.wide {
		grid-column: 1 / -1;
	}
</style>
