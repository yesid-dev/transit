<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordEvidence } from '#lib/server/engine.ts';
	import RecordActions from './RecordActions.svelte';
	import { finderCsv } from './finderText.ts';
	import { dateRange, methodEvidence } from '#lib/site/presenter.ts';

	let {
		locale,
		title,
		url,
		section,
		headers,
		rows,
		city,
		period,
		sources,
	}: {
		locale: Locale;
		title: string;
		url: URL;
		section: string;
		headers: string[];
		rows: (string | number | null)[][];
		city: string;
		period: { from: string; to: string };
		sources: { evidence: RecordEvidence; label?: string }[];
	} = $props();
	const href = $derived(new URL('#' + section, url).href);
	const csv = $derived(
		finderCsv(
			headers,
			rows,
			locale,
			city,
			period,
			sources.map(({ evidence }) => evidence),
		),
	);
	const citation = $derived(
		[
			`Transit. ${title}. ${dateRange(period, locale)}.`,
			...sources.map(({ evidence, label }) =>
				[label, methodEvidence(evidence, locale)].filter(Boolean).join(' '),
			),
			href,
		].join(' '),
	);
</script>

<RecordActions
	{locale}
	{title}
	{href}
	{csv}
	csvName={`${section}-${period.from}-${period.to}.csv`}
	{citation}
/>
