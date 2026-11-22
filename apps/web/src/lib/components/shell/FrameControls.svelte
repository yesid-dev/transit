<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { DateRangePicker } from '@yesid/ui/layout';
	import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@yesid/ui/sheet';
	import { delocalizePath, intl, type Locale } from '#lib/i18n/index.ts';
	import { isRankingPath } from '#lib/features/rankings/rankingSelection.ts';
	import { usesFinderRecord } from '#lib/site/finderFrame.ts';
	import {
		frameHref,
		frameToday,
		MAX_RECORD_DAYS,
		parseFrameState,
		presetPeriod,
		PRESETS,
		RECORD_START,
		type FrameMode,
	} from '#lib/site/frameState.ts';

	let { locale, url }: { locale: Locale; url: URL } = $props();

	const translations = {
		en: {
			view: 'View',
			live: 'Live now',
			record: 'Record',
			period: 'Period',
			close: 'Close the controls',
			presets: ['Yesterday', 'Last 7 complete days', 'Last 28 days', 'This month', 'Last month'],
			ranges: 'Ready ranges',
			custom: 'Choose other dates',
			from: 'From',
			to: 'To',
			apply: 'Show these dates',
			note: (date: string) => `Record starts ${date}.`,
			scope: 'Current pages still use their own data and filters.',
			error: {
				invalidDate: 'Enter both dates.',
				reversed: 'The end date must be on or after the start date.',
				beforeRecord: 'Choose dates on or after the start of the record.',
				future: 'Choose dates up to today.',
				tooLong: `Choose a period of at most ${MAX_RECORD_DAYS} days.`,
			},
		},
		fr: {
			view: 'Vue',
			live: 'En direct',
			record: 'Bilan',
			period: 'Période',
			close: 'Fermer les commandes',
			presets: [
				'Hier',
				'7 derniers jours complets',
				'28 derniers jours',
				'Ce mois-ci',
				'Le mois dernier',
			],
			ranges: 'Plages prêtes',
			custom: "Choisir d'autres dates",
			from: 'Du',
			to: 'Au',
			apply: 'Afficher ces dates',
			note: (date: string) => `Le bilan commence le ${date}.`,
			scope: 'Les pages actuelles utilisent encore leurs propres données et filtres.',
			error: {
				invalidDate: 'Entrez les deux dates.',
				reversed: 'La date de fin doit être égale ou postérieure à la date de début.',
				beforeRecord: 'Choisissez des dates à partir du début du bilan.',
				future: 'Choisissez des dates au plus tard aujourd’hui.',
				tooLong: `Choisissez une période d’au plus ${MAX_RECORD_DAYS} jours.`,
			},
		},
	} as const;

	const uid = $props.id();
	const copy = $derived(translations[locale]);
	let today = $state(frameToday());
	const path = $derived(delocalizePath(url.pathname));
	const rankings = $derived(isRankingPath(path.replace(/\/$/, '')));
	const frame = $derived.by(() => {
		const state = parseFrameState(url.searchParams, today);
		return rankings ? { ...state, mode: 'record' as const } : state;
	});
	const line = $derived(/^\/lines\/[^/]+\/?$/.test(path));
	const stop = $derived(/^\/stop\/[^/]+\/?$/.test(path));
	const finder = $derived((path === '/lines' || path === '/stops') && usesFinderRecord(url));
	const usesFrameRecord = $derived(path === '/' || line || stop || rankings || finder);
	const startLabel = $derived(
		intl.dateTime(locale, { timeZone: 'UTC', dateStyle: 'long' }).format(new Date(RECORD_START)),
	);
	const rangeLabel = $derived.by(() => {
		if (!frame.period) return '';
		const { from, to } = frame.period;
		const formatter = intl.dateTime(locale, {
			timeZone: 'UTC',
			month: 'short',
			day: 'numeric',
			year:
				from.slice(0, 4) === today.slice(0, 4) && to.slice(0, 4) === today.slice(0, 4)
					? undefined
					: 'numeric',
		});
		return formatter.formatRange(new Date(from), new Date(to));
	});
	const modes = $derived([
		{ key: 'live' as const, label: copy.live },
		{ key: 'record' as const, label: copy.record },
	]);

	let open = $state(false);
	function onOpenChange(next: boolean) {
		if (!next) return;
		today = frameToday();
	}

	function selectMode(mode: FrameMode) {
		if (frame.mode === mode) return;
		const target = new URL(frameHref(url, { ...frame, mode }), url);
		if (line || stop) {
			if (mode === 'live') target.searchParams.set('tab', 'detail');
			else target.searchParams.delete('tab');
		}
		void goto(target, { shallow: !usesFrameRecord, state: { ...page.state } });
	}

	function selectPeriod(period: NonNullable<typeof frame.period>) {
		open = false;
		void goto(frameHref(url, { ...frame, period, mode: finder ? 'record' : frame.mode }), {
			shallow: !usesFrameRecord || (frame.mode === 'live' && !finder),
			state: { ...page.state },
		});
	}
</script>

{#if !rankings && !finder}
	<SegmentedChoice options={modes} value={frame.mode} label={copy.view} onSelect={selectMode} />
{/if}
<Sheet bind:open {onOpenChange}>
	<SheetTrigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="cta-sm" wrap class="min-h-11 max-w-full">
				<span>{rangeLabel ? `${copy.period} · ${rangeLabel}` : copy.period}</span>
			</Button>
		{/snippet}
	</SheetTrigger>
	<SheetContent closeLabel={copy.close} class="overflow-y-auto p-4" data-lenis-prevent>
		<div class="mx-auto grid w-full max-w-xl gap-4 pr-8">
			<SheetTitle>{copy.period}</SheetTitle>
			<SheetDescription id={`${uid}-note`}>
				{copy.note(startLabel)}
				{#if !usesFrameRecord}{copy.scope}{/if}
			</SheetDescription>
			<div class="flex flex-wrap gap-2" role="group" aria-label={copy.ranges}>
				{#each PRESETS as preset, index (preset)}
					{@const period = presetPeriod(preset, today)}
					<Button
						variant={frame.period?.preset === preset ? 'default' : 'outline'}
						size="cta-sm"
						wrap
						class="min-h-11"
						aria-pressed={frame.period?.preset === preset}
						disabled={!period}
						onclick={() => period && selectPeriod(period)}
					>
						{copy.presets[index]}
					</Button>
				{/each}
			</div>
			<DateRangePicker
				presets={[]}
				value={{ start: frame.period?.from ?? '', end: frame.period?.to ?? '' }}
				min={RECORD_START}
				max={today}
				labels={{
					legend: copy.custom,
					presets: copy.ranges,
					custom: copy.custom,
					start: copy.from,
					end: copy.to,
					apply: copy.apply,
					missing: copy.error.invalidDate,
					bounds: `${copy.error.beforeRecord} ${copy.error.future}`,
					order: copy.error.reversed,
				}}
				onValueChange={({ start, end }) => selectPeriod({ from: start, to: end, preset: null })}
			/>
		</div>
	</SheetContent>
</Sheet>
