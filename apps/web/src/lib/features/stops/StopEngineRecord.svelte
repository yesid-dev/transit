<script lang="ts">
	import { StatusMark } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import RecordPunctualityDays from '#lib/features/record/RecordPunctualityDays.svelte';
	import RecordSeriesChart from '#lib/features/record/RecordSeriesChart.svelte';
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import RecordActions from '#lib/features/record/RecordActions.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import WaitingReadings from '#lib/features/record/WaitingReadings.svelte';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import {
		choose,
		dateRange,
		lastGoodNote,
		measuredShare,
		percent,
		punctualityBands,
		recordMessage,
		shareReading,
		pooledDays,
		punctualityWeighting,
		timingBasis,
		tally,
	} from '#lib/features/record/recordText.ts';
	import type { RecordCell } from '#lib/server/engine.ts';
	import type { loadStopRecord } from '#lib/server/stopRecord.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { stopViewHref } from '#lib/site/stopFrame.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import type { IdentitySeed } from '#lib/v1/serverContext.ts';
	import StopViewNav from './StopViewNav.svelte';
	import {
		stopAccessibility,
		stopAccessibilityDescription,
		stopAnswer,
		stopCitation,
		stopDelay,
		stopSectionTitles,
	} from './stopRecordText.ts';

	let {
		stop,
		code,
		locale,
		url,
		record,
	}: {
		stop: IdentitySeed;
		code?: string | null;
		locale: Locale;
		url: URL;
		record: ReturnType<typeof loadStopRecord>;
	} = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const stopLabel = $derived(t(`Stop ${code || stop.id}`, `Arrêt ${code || stop.id}`));
	const name = $derived(stop.name === stop.id ? null : stopDisplayName(stop.name));
	const subject = $derived(name ? `${stopLabel} · ${name}` : stopLabel);
	const pinned = $derived.by(() => {
		const link = stopViewHref(url, 'record');
		link.searchParams.set('provider', record.city);
		return new URL(
			frameHref(link, { mode: 'record', period: { ...record.period, preset: null } }),
			url,
		);
	});
	const back = $derived(carryFrameState(localizeHref('/stops', locale, record.city), pinned));
	const day = (day: string) =>
		intl.dateTime(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(day));
	const label = (cell: RecordCell & { key: Record<string, string | number | null> }) => {
		if (typeof cell.key.line === 'string') return display.lineName(cell.key.line).label;
		if (typeof cell.key.hour === 'number') return `${String(cell.key.hour).padStart(2, '0')}:00`;
		if (typeof cell.key.day === 'string') return day(cell.key.day);
		return t('Unknown', 'Inconnu');
	};
	const count = (value: number | null | undefined) =>
		value == null ? t('Unknown', 'Inconnu') : tally(value, locale);
</script>

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<a class="inline-flex min-h-11 w-fit items-center" href={back}>
				{t('All stops', 'Tous les arrêts')}
			</a>
			<h1>{name ?? stopLabel}</h1>
			{#if name}<p>{stopLabel}</p>{/if}
			<StopViewNav url={pinned} {locale} view="record" />
			<p>{dateRange(record.period, locale)}</p>
		</header>

		{#each record.sections as { section, answer } (section)}
			{@const title = t(...stopSectionTitles[section])}
			{@const links = recordSectionLinks(pinned, section)}
			<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
				<section id={section} aria-labelledby={`${section}-title`} class="grid min-w-0 gap-3">
					<h2 id={`${section}-title`}>{title}</h2>
					{#if section === 'accessibility'}<p>{stopAccessibilityDescription[locale]}</p>{/if}
					{#await answer}
						{#key answer}<RecordPending {locale} />{/key}
					{:then result}
						{@const message = recordMessage(result, locale)}
						{#if result.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
						{#if message}<StateNotice presentation="frameless" title={message} />{/if}
						{#if result.kind === 'answer'}
							{@const data = result.answer}
							{#if section === 'waiting' && 'cells' in data && data.cells.length}
								<WaitingReadings {data} {locale} {title} />
							{:else if !message}
								{#if 'value' in data}
									{#if section === 'punctuality'}
										{@const basis = timingBasis(data.evidence.counts, locale)}
										<p>{stopAnswer(data, locale)}</p>
										{#if basis}<p>{basis}</p>{/if}
										<p>{punctualityWeighting[locale]}</p>
										{#if data.evidence.start_date !== data.evidence.end_date}<p>
												{pooledDays[locale]}
											</p>{/if}
										<dl class="flex flex-wrap gap-4">
											{#each punctualityBands(data, locale) as band (band.id)}
												<div>
													<dt><StatusMark status={band.id} label={band.label} /></dt>
													<dd>{band.reading}</dd>
												</div>
											{/each}
										</dl>
									{:else if section === 'delay'}
										{@const basis = timingBasis(data.evidence.counts, locale)}
										{#if basis}<p>{basis}</p>{/if}
										<dl class="flex flex-wrap gap-4">
											<div>
												<dt>{t('Median delay', 'Retard médian')}</dt>
												<dd>{stopDelay(data.value.median_delay, locale)}</dd>
											</div>
											<div>
												<dt>{t('90th percentile', '90e centile')}</dt>
												<dd>{stopDelay(data.value.p90_delay, locale)}</dd>
											</div>
										</dl>
									{:else if section === 'accessibility'}
										<p>{stopAccessibility(data, locale)}</p>
									{:else if section === 'alerts'}
										<dl class="flex flex-wrap gap-4">
											<div>
												<dt>{t('Distinct alerts', 'Avis distincts')}</dt>
												<dd>{count(data.value.alerts)}</dd>
											</div>
											<div>
												<dt>{t('Versions of those alerts', 'Versions de ces avis')}</dt>
												<dd>{count(data.value.alert_versions)}</dd>
											</div>
										</dl>
									{/if}
								{:else if 'cells' in data}
									{#if section === 'daily'}
										<RecordPunctualityDays {title} series={data} {locale} />
									{:else if section === 'hourly'}
										{@const hours = new Map(data.cells.map((cell) => [cell.key.hour, cell]))}
										<RecordSeriesChart
											{title}
											kind="line"
											seriesLabel={t('On-time share', 'Part à l’heure')}
											points={Array.from({ length: 24 }, (_, x) => ({
												x,
												y: measuredShare(hours.get(x), 'on_time'),
											}))}
											ticks={[0, 6, 12, 18, 23].map((value) => ({
												value,
												label: `${String(value).padStart(2, '0')}:00`,
											}))}
											yMax={1}
											format={(value) => percent(value, locale)}
										/>
									{/if}
									<RecordTable
										{title}
										headers={[
											section === 'byLine'
												? t('Line', 'Ligne')
												: section === 'hourly'
													? t('Scheduled local hour', 'Heure locale prévue')
													: t('Service date', 'Date de service'),
											t(
												'On-time share (on time / observed)',
												'Part à l’heure (à l’heure / observés)',
											),
										]}
										rows={data.cells.map((cell) => [
											label(cell),
											shareReading(cell, 'on_time', locale),
										])}
									/>
								{/if}
							{/if}
							{#if data.coverage_note}<p>{data.coverage_note[locale]}</p>{/if}
							<RecordActions
								{locale}
								{title}
								href={links.share}
								csv={links.csv}
								citation={stopCitation(
									subject,
									section,
									data,
									locale,
									links.share,
									result.lastGood,
								)}
							/>
						{/if}
					{/await}
				</section>
			</Card>
		{/each}
	</div>
</Surface>
