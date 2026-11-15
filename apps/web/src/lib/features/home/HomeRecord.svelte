<script lang="ts">
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { fmtCount } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { createRecordStamp } from '#lib/v1/recordStamp.svelte.ts';
	import { getHistoricAvailability, getNetworkTrend } from '#lib/v1/repositories/historic.ts';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import { stampText } from '#lib/v1/stamp.ts';
	import { formatWeek, latestCompleteWeek, type RecordWeek } from './homeRecord';
	import type { HomePulseCopy } from './homePulse.copy';

	interface Props {
		readonly locale: Locale;
		/** Absent before the data context boots: the card keeps its shape and its link. */
		readonly manifest: Manifest | null;
		readonly copy: HomePulseCopy;
	}

	let { locale, manifest, copy: t }: Props = $props();
	const localizeHref = getLocalizeHref();

	const trend = createResource((signal) => getNetworkTrend({ signal }), {
		key: () => 'home-network-trend',
		enabled: () => manifest != null,
	});
	const history = createResource(
		(signal) => getHistoricAvailability({ signal, manifest: manifest ?? undefined }),
		{ key: () => 'home-history-index', enabled: () => manifest != null },
	);
	// The stamp dates this card's own file and closes on the same history index, read once.
	const stamp = createRecordStamp(
		() => manifest,
		() => trend.data?.generated_utc ?? null,
		() => ({
			rootIndex: history.data ?? null,
			state: history.settled || history.error ? 'ready' : 'loading-index',
		}),
	);

	const record = $derived(
		trend.error || history.error
			? ({ kind: 'error' } as const)
			: manifest && trend.settled && history.settled
				? latestCompleteWeek(trend.data, history.data)
				: ({ kind: 'loading' } as const),
	);
	const stampMeta = $derived(trend.data ? stamp.meta(locale) : null);

	const pct = (value: number) => fmtLocalePct(value, locale) ?? '';
	const week = (value: RecordWeek) => formatWeek(value, locale);
	const message = $derived(
		record.kind === 'held'
			? record.reason === 'thin'
				? t.recordThin.replace('{n}', fmtCount(record.readings, { locale }) ?? '')
				: t.recordUnpublished
			: record.kind === 'none'
				? t.recordNone
				: record.kind === 'error'
					? t.recordError
					: null,
	);

	// Every slot reserves the longest text it can hold in this language, drawn by CSS outside the
	// accessible text, so nothing below the card moves when the record arrives or is held back.
	const longest = $derived.by(() => {
		const crossYear = week({ from: '2026-12-28', to: '2027-01-03' });
		const messages = [
			t.recordThin.replace('{n}', '29'),
			t.recordUnpublished,
			t.recordNone,
			t.recordError,
		];
		return {
			period: t.recordPeriod.replace('{dates}', crossYear),
			figure: pct(100),
			message: messages.reduce((a, b) => (b.length > a.length ? b : a)),
			basis: `${t.recordBasis.replace('{n}', fmtCount(99_999_999, { locale }) ?? '')} ${t.recordUnits}`,
			before: `${pct(100)} ${t.recordBefore.replace('{dates}', crossYear)}`,
			stamp: stampText(
				{
					form: 'record',
					scope: 'window',
					dataThrough: '2025-09-30',
					publishedOn: '2025-10-01',
					nextUpdateUtc: null,
					warning: false,
				},
				locale,
				manifest?.tz,
			),
		};
	});
</script>

<section class="home-record" data-slot="home-record" aria-labelledby="home-record-title">
	<h2 id="home-record-title">{t.recordTitle}</h2>
	<div class="record-body" aria-busy={record.kind === 'loading'}>
		<div class="record-answer">
			<p class="slot record-period">
				<span>
					{#if record.kind === 'week' || record.kind === 'held'}
						{t.recordPeriod.replace('{dates}', week(record.week))}
					{/if}
				</span>
				<span class="reserve" aria-hidden="true" data-reserve={longest.period}></span>
			</p>
			<div class="slot">
				{#if record.kind === 'week'}
					<p class="record-line">
						<span class="record-figure">{pct(record.onTimePct)}</span>
						{t.recordShare}
					</p>
				{:else if message}
					<p class="record-message" role="status">{message}</p>
				{/if}
				<p
					class="reserve record-line"
					aria-hidden="true"
					data-reserve-figure={longest.figure}
					data-reserve={t.recordShare}
				></p>
				<p class="reserve record-message" aria-hidden="true" data-reserve={longest.message}></p>
			</div>
			<p class="slot record-definition">
				<span
					>{#if record.kind === 'week'}{t.recordDefinition}{/if}</span
				>
				<span class="reserve" aria-hidden="true" data-reserve={t.recordDefinition}></span>
			</p>
		</div>
		<div class="record-evidence">
			<p class="slot">
				<span>
					{#if record.kind === 'week'}
						<span class="record-lead">
							{t.recordBasis.replace('{n}', fmtCount(record.readings, { locale }) ?? '')}
						</span>
						<span class="record-muted">{t.recordUnits}</span>
					{/if}
				</span>
				<span class="reserve" aria-hidden="true" data-reserve={longest.basis}></span>
			</p>
			<p class="slot">
				<span>
					{#if record.kind === 'week' && record.previous}
						<span class="record-lead">{pct(record.previous.onTimePct)}</span>
						{t.recordBefore.replace('{dates}', week(record.previous.week))}
					{/if}
				</span>
				<span class="reserve" aria-hidden="true" data-reserve={longest.before}></span>
			</p>
			<p class="slot record-stamp">
				<span>
					{#if stampMeta?.text}
						<CalendarIcon size={16} strokeWidth={1.8} aria-hidden="true" />
						<time datetime={stampMeta.datetime}>{stampMeta.text}</time>
					{/if}
				</span>
				<span class="reserve" aria-hidden="true" data-reserve={longest.stamp}></span>
			</p>
		</div>
	</div>
	<p class="home-card-actions">
		<a class="home-card-action" href={localizeHref(routeFor({ kind: 'network-health' }), locale)}
			>{t.openRecord}</a
		>
	</p>
</section>

<style>
	.home-record {
		container-type: inline-size;
	}
	.record-body {
		display: grid;
		gap: 1rem 2rem;
	}
	.record-answer,
	.record-evidence {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.record-body p {
		margin: 0;
	}
	/* A slot holds its text and the longest text it may hold; the taller one sets its height. */
	.slot {
		display: grid;
		align-items: start;
	}
	.slot > * {
		grid-area: 1 / 1;
		min-width: 0;
	}
	.reserve {
		visibility: hidden;
	}
	.reserve::before {
		content: attr(data-reserve-figure);
	}
	.reserve::after {
		content: attr(data-reserve);
	}
	.record-period {
		font-weight: 600;
		line-height: 1.4;
	}
	.record-line {
		line-height: 1.3;
	}
	.record-figure,
	.reserve.record-line::before {
		margin-right: 0.375rem;
		font-family: var(--font-heading);
		font-size: var(--text-display);
		font-weight: 800;
		line-height: 1;
		letter-spacing: var(--tracking-tight);
		font-variant-numeric: tabular-nums;
		color: var(--foreground);
	}
	.record-message {
		line-height: 1.5;
		color: var(--secondary-foreground);
	}
	.record-definition,
	.record-muted {
		color: var(--muted-foreground);
	}
	.record-definition {
		font-size: var(--text-small);
		line-height: 1.5;
	}
	.record-evidence {
		line-height: 1.5;
	}
	.record-lead,
	.record-evidence .reserve {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.record-stamp {
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.record-stamp > span:first-child {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}
	.record-stamp :global(svg) {
		flex: none;
		margin-top: 0.15em;
	}
	.record-stamp .reserve {
		padding-left: calc(16px + 0.5rem);
	}
	@container (min-width: 34rem) {
		.record-body {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
		.record-evidence {
			padding-left: 2rem;
			border-left: 1px solid var(--border-subtle);
		}
	}
</style>
