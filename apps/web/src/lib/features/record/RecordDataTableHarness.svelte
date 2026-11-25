<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordDataTable, { type RecordTableRow } from './RecordDataTable.svelte';
	import RecordTableValue from './RecordTableValue.svelte';
	import type { RecordState } from './recordStates.ts';

	let { locale }: { locale: Locale } = $props();
	type Row = RecordTableRow & { reading: string | null; state?: RecordState };
	const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({
		id: String(i + 1),
		label: 'Station ' + (i + 1),
		href: '/stop/' + (i + 1),
		reading: i === 1 ? null : String(i + 1),
		state: i === 1 ? 'unknown' : undefined,
	}));
	let direction = $state<'asc' | 'desc'>('asc');
	const shown = $derived(direction === 'asc' ? rows : rows.toReversed());
</script>

{#snippet reading(row: Row)}
	<RecordTableValue {locale} text={row.reading} state={row.state} />
{/snippet}

<RecordDataTable
	{locale}
	title={locale === 'fr' ? 'Arrêts mesurés' : 'Measured stops'}
	rowHeader={locale === 'fr' ? 'Arrêt' : 'Stop'}
	rows={shown}
	columns={[
		{
			key: 'reading',
			header: locale === 'fr' ? 'Passages' : 'Readings',
			numeric: true,
			sortable: true,
			cell: reading,
		},
	]}
	value="reading"
	sort={{
		key: 'reading',
		direction,
		onSort: () => (direction = direction === 'asc' ? 'desc' : 'asc'),
	}}
/>
