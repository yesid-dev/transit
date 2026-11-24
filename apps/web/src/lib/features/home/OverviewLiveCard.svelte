<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { StatusMark, type StampProps } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import { countedUnit, liveStampAge, recordRatio } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { recordState } from '../record/recordStates';
	import { overviewCopy } from './overviewRecord.copy';
	import { lateLines, tally } from './overviewRecord';
	import { selectLivePulse } from './homePulse';

	let {
		locale,
		manifest,
		alertsAvailable,
		link,
	}: {
		locale: Locale;
		manifest: Manifest | null;
		alertsAvailable: boolean;
		link: (path: string, live?: boolean) => string;
	} = $props();

	const t = $derived(overviewCopy[locale]);
	const display = transitDisplay();
	const live = untrack(() =>
		manifest
			? createLiveStore(manifest, liveReader, {
					families: alertsAvailable ? ['network', 'vehicles', 'alerts'] : ['network', 'vehicles'],
				})
			: null,
	);
	onMount(() => {
		live?.start();
		return () => live?.stop();
	});

	const pulse = $derived(selectLivePulse(live?.network ?? null));
	const distribution = $derived(live?.network?.status_dist);
	const lines = $derived(lateLines(live?.vehicles?.vehicles ?? []));
	const generated = $derived(live?.network?.generated_utc);
	const stamp: StampProps = $derived({
		kind: 'live',
		label: t.live,
		updatedAt: generated ? new Date(generated) : undefined,
		agoLabel: (seconds) => liveStampAge(seconds, locale),
		late: !generated || live?.familyStates.network.health.isStale,
	});
	const reporting = $derived(pulse?.reporting ?? null);
	const statuses = ['early', 'on_time', 'late', 'unknown'] as const;
</script>

<RecordCard title={t.live} {stamp}>
	<RecordAnswer
		{locale}
		state="no_live_data"
		value={reporting == null ? null : tally(reporting, locale)}
		sentence={reporting == null
			? recordState('no_live_data')[locale]
			: reporting === 1
				? t.reportingOne
				: t.reporting}
	/>
	{#if distribution}
		<dl class="mt-3 grid gap-2">
			{#each statuses as status (status)}
				<div
					class="flex flex-wrap items-baseline justify-between gap-x-2 border-b border-border pb-2"
				>
					<dt>
						{#if status === 'unknown'}<StateMark state="unknown" {locale} />
						{:else}<StatusMark {status} label={status === 'on_time' ? t.onTime : t[status]} />{/if}
					</dt>
					<dd>{countedUnit(distribution[status], 'vehicle', locale)}</dd>
				</div>
			{/each}
		</dl>
	{/if}
	<dl class="mt-3 grid gap-2">
		<div class="flex flex-wrap items-baseline justify-between gap-x-2">
			<dt>{t.silent}</dt>
			<dd>
				{#if pulse?.silent == null}<StateMark state="no_live_data" {locale} />{:else}{tally(
						pulse.silent,
						locale,
					)}{/if}
			</dd>
		</div>
		{#if alertsAvailable}
			<div class="flex flex-wrap items-baseline justify-between gap-x-2">
				<dt>{t.alerts}</dt>
				<dd>
					{#if live?.alerts}<span>{tally(live.alerts.alerts.length, locale)}</span>{:else}<StateMark
							state="no_live_data"
							{locale}
						/>{/if}
				</dd>
			</div>
		{/if}
	</dl>
	{#if lines.length}
		<h3 class="mt-4 font-semibold">{t.lateLines}</h3>
		<ul>
			{#each lines as row (row.id)}
				{@const line = display.lineName(row.id)}
				<li class="flex flex-wrap items-center justify-between gap-x-2 border-t border-border">
					<a
						class="inline-flex min-h-11 items-center text-primary underline"
						href={link('/lines/' + encodeURIComponent(row.id), true)}>{line.label}</a
					>
					<span>{recordRatio(row.late, countedUnit(row.total, 'vehicle', locale), locale)}</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#snippet footer()}
		<a class="inline-flex min-h-11 items-center text-primary underline" href={link('/map', true)}
			>{t.openMap}</a
		>
		{#if alertsAvailable}<a
				class="inline-flex min-h-11 items-center text-primary underline"
				href={link('/alerts', true)}>{t.readAlerts}</a
			>{/if}
	{/snippet}
</RecordCard>
