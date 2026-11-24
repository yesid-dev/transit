<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { RoutePlate, StatusMark, type StampProps } from '@yesid/ui/brand';
	import { Skeleton } from '@yesid/ui/skeleton';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { createLiveStore, type LiveFamilyState } from '#lib/v1/live/store.svelte.ts';
	import { countedUnit, liveStampAge, recordRatio, singularCount } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { recordState } from '../record/recordStates';
	import { overviewCopy } from './overviewRecord.copy';
	import { lateLines, tally } from './overviewRecord';
	import { selectLivePulse } from './homePulse';
	import { homePulseCopy } from './homePulse.copy';

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
	const unavailable = $derived(homePulseCopy[locale].liveUnavailable);
	const networkAvailable = $derived(manifest?.capabilities?.live_map !== 'unavailable');
	const display = transitDisplay();
	const live = untrack(() =>
		manifest
			? createLiveStore(manifest, liveReader, {
					families: [
						...(networkAvailable ? (['network', 'vehicles'] as const) : []),
						...(alertsAvailable ? (['alerts'] as const) : []),
					],
				})
			: null,
	);
	onMount(() => {
		live?.start();
		return () => live?.stop();
	});

	const pulse = $derived(selectLivePulse(live?.network ?? null));
	const health = $derived(live?.familyStates.network.health);
	const alertHealth = $derived(live?.familyStates.alerts.health);
	const stale = (health: LiveFamilyState['health'] | undefined) =>
		!!health?.retained && (health.isStale || health.notice != null);
	const networkStale = $derived(stale(health));
	const distribution = $derived(live?.network?.status_dist);
	const lines = $derived(lateLines(live?.vehicles?.vehicles ?? []));
	const generated = $derived(live?.network?.generated_utc);
	const stamp: StampProps = $derived({
		kind: 'live',
		label: networkStale ? liveStampAge(health?.ageSeconds ?? null, locale, 'behind') : t.live,
		updatedAt: generated ? new Date(generated) : undefined,
		agoLabel: (seconds) => liveStampAge(seconds, locale),
		late: networkStale || health?.state === 'failed-no-data',
	});
	function reading(
		value: number | null | undefined,
		family: LiveFamilyState | undefined,
		available: boolean,
	) {
		if (!available) return { kind: 'no-data' } as const;
		if (value != null) return { kind: 'value', value } as const;
		if (!family || family.health.state === 'failed-no-data') return { kind: 'failed' } as const;
		if (!family.health.retained && (family.phase === 'idle' || family.phase === 'loading'))
			return { kind: 'pending' } as const;
		return { kind: 'no-data' } as const;
	}
	const reporting = $derived(
		reading(pulse?.reporting, live?.familyStates.network, networkAvailable),
	);
	const silent = $derived(reading(pulse?.silent, live?.familyStates.network, networkAvailable));
	const alerts = $derived(
		reading(live?.alerts?.alerts.length, live?.familyStates.alerts, alertsAvailable),
	);
	const statuses = ['early', 'on_time', 'late', 'unknown'] as const;
</script>

{#snippet readingValue(entry: ReturnType<typeof reading>)}
	{#if entry.kind === 'value'}{tally(entry.value, locale)}
	{:else if entry.kind === 'pending'}<Skeleton class="h-lh w-16 max-w-full" />
	{:else if entry.kind === 'failed'}<span>{unavailable}</span>
	{:else}<StateMark state="no_live_data" {locale} />{/if}
{/snippet}

<RecordCard title={t.live} {stamp}>
	<div aria-busy={reporting.kind === 'pending'} class="min-h-16">
		{#if reporting.kind === 'pending'}
			<Skeleton class="h-12 w-28 max-w-full" />
		{:else}
			<RecordAnswer
				{locale}
				state={reporting.kind === 'no-data' ? 'no_live_data' : undefined}
				value={reporting.kind === 'value' ? tally(reporting.value, locale) : null}
				sentence={reporting.kind === 'failed'
					? unavailable
					: reporting.kind === 'no-data'
						? recordState('no_live_data')[locale]
						: singularCount(reporting.value, locale)
							? t.reportingOne
							: t.reporting}
			/>
		{/if}
	</div>
	{#if distribution}
		<dl class="mt-3 grid gap-2">
			{#each statuses as status (status)}
				<div
					class="flex flex-wrap items-baseline justify-between gap-x-2 border-b border-border pb-2"
				>
					<dt>
						{#if status === 'unknown'}<StateMark state="delay_unknown" {locale} />
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
			<dd aria-busy={silent.kind === 'pending'}>{@render readingValue(silent)}</dd>
		</div>
		<div class="flex flex-wrap items-baseline justify-between gap-x-2">
			<dt>{t.alerts}</dt>
			<dd aria-busy={alerts.kind === 'pending'}>
				{@render readingValue(alerts)}
				{#if stale(alertHealth)}<p class="text-muted-foreground">
						{liveStampAge(alertHealth?.ageSeconds ?? null, locale, 'behind')}
					</p>{/if}
			</dd>
		</div>
	</dl>
	{#if lines.length}
		<h3 class="mt-4 font-semibold">{t.lateLines}</h3>
		<ul>
			{#each lines as row (row.id)}
				{@const line = display.lineName(row.id)}
				<li class="late-line border-t border-border">
					<span><RoutePlate code={line.number ?? row.id} /></span>
					<a
						class="inline-flex min-h-11 min-w-11 items-center text-primary underline"
						href={link('/lines/' + encodeURIComponent(row.id), true)}>{line.name ?? line.label}</a
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

<style>
	.late-line {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
		align-items: baseline;
		gap: 0.5em;
	}
	.late-line > :last-child {
		text-align: end;
	}
</style>
