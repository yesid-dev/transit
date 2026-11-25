<script lang="ts">
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	const { directionLabel } = transitDisplay();
	import { Card } from '@yesid/ui/card';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Surface } from '@yesid/ui/layout';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import RecordActions from '#lib/features/record/RecordActions.svelte';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordLineLabel from '#lib/features/record/RecordLineLabel.svelte';
	import { choose, lastGoodNote, recordMessage } from '#lib/features/record/recordText.ts';
	import { dateRange } from '#lib/site/presenter.ts';
	import type { loadLineRecord } from '#lib/server/lineRecord.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import WaitingReadings from '#lib/features/record/WaitingReadings.svelte';
	import LineRecordReadings from './LineRecordReadings.svelte';
	import LineViewNav from './LineViewNav.svelte';
	import LineRecordTop from './LineRecordTop.svelte';
	import { lineCitation, lineSectionTitles, lineViewHref } from './lineRecordText.ts';

	let {
		name,
		lineId,
		code,
		subtitle,
		scheduleOnly,
		locale,
		url,
		record,
		headsigns,
		stopNames: stopNamesById,
	}: {
		name: string;
		lineId?: string;
		code?: string | null;
		subtitle?: string;
		scheduleOnly?: boolean;
		locale: Locale;
		url: URL;
		record: ReturnType<typeof loadLineRecord>;
		headsigns: Record<number, string>;
		stopNames: Record<string, string>;
	} = $props();

	const stopNames = $derived(new Map(Object.entries(stopNamesById)));
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const pinned = $derived.by(() => {
		const link = lineViewHref(url, record.view, record.direction);
		link.searchParams.set('provider', record.city);
		return new URL(
			frameHref(link, { mode: 'record', period: { ...record.period, preset: null } }),
			url,
		);
	});
	const back = $derived(carryFrameState(localizeHref('/lines', locale, record.city), pinned));
	const corridorMap = $derived.by(() => {
		if (!lineId) return '';
		const target = new URL(localizeHref('/map', locale, record.city), pinned);
		target.searchParams.set('mapLayer', 'corridors');
		target.searchParams.set('recordLine', lineId);
		if (record.direction != null) target.searchParams.set('recordDirection', record.direction);
		return frameHref(target, { mode: 'record', period: { ...record.period, preset: null } });
	});
</script>

<Surface>
	<div class="grid min-w-0 gap-4 lg:gap-3">
		{#if record.view === 'record'}
			<LineRecordTop
				{name}
				{code}
				{subtitle}
				{scheduleOnly}
				{locale}
				{record}
				{pinned}
				{back}
				{headsigns}
			/>
			<div class="flex flex-wrap gap-4">
				<a
					class="inline-flex min-h-11 items-center text-primary underline"
					href={lineViewHref(pinned, 'schedule').href}
				>
					{t('Schedule', 'Horaire')}
				</a>
				{#if corridorMap}
					<a class="inline-flex min-h-11 items-center text-primary underline" href={corridorMap}>
						{t('See corridors on the map', 'Voir les corridors sur la carte')}
					</a>
				{/if}
			</div>
		{:else}
			<header class="grid gap-2">
				<a class="inline-flex min-h-11 w-fit items-center" href={back}>
					{t('All lines', 'Toutes les lignes')}
				</a>
				<h1><RecordLineLabel label={name} code={code ?? null} {scheduleOnly} size="lg" /></h1>
				{#if scheduleOnly}
					<StateNotice
						presentation="frameless"
						title={t('No live data', 'Aucune donnée en direct')}
					/>
				{/if}
				<LineViewNav url={pinned} {locale} view={record.view} />
				{#if corridorMap}
					<a class="inline-flex min-h-11 w-fit items-center" href={corridorMap}>
						{t('See corridors on the map', 'Voir les corridors sur la carte')}
					</a>
				{/if}
				<p>{dateRange(record.period, locale)}</p>
			</header>
		{/if}

		{#each record.sections.filter(({ section }) => !['punctuality', 'directions', 'daily', 'hourly'].includes(section)) as { section, answer } (section)}
			{@const title = t(...lineSectionTitles[section])}
			{@const links = recordSectionLinks(pinned, section)}
			<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
				<section id={section} aria-labelledby={`${section}-title`} class="grid min-w-0 gap-3">
					<h2 id={`${section}-title`}>{title}</h2>
					{#if section === 'offered'}
						<a class="inline-flex min-h-11 items-center" href="#delivery">
							{t(
								'See scheduled and delivered trips by departure',
								'Voir les trajets prévus et effectués par départ',
							)}
						</a>
					{/if}
					{#await answer}
						{#key answer}<RecordPending {locale} {answer} />{/key}
					{:then result}
						{@const message = recordMessage(result, locale)}
						{#if result.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
						{#if result.kind === 'busy'}
							<RecordPending {locale} busy />
						{:else if message && (section !== 'waiting' || result.kind !== 'answer')}
							<StateNotice presentation="frameless" title={message} />
						{/if}
						{#if result.kind === 'answer'}
							{#if section === 'waiting' && 'value' in result.answer}
								<WaitingReadings data={result.answer} {locale} {title} />
							{:else if !message}
								<LineRecordReadings
									answer={result.answer}
									{section}
									{locale}
									{title}
									{headsigns}
									{stopNames}
									url={pinned}
									line={record.line}
									city={record.city}
									direction={record.direction}
								/>
							{/if}
							{#if result.answer.coverage_note}<p>{result.answer.coverage_note[locale]}</p>{/if}
							<RecordActions
								{locale}
								{title}
								href={links.share}
								csv={links.csv}
								citation={lineCitation(name, title, result.answer, locale, links.share)}
							/>
						{/if}
					{/await}
				</section>
			</Card>
		{/each}
	</div>
</Surface>
