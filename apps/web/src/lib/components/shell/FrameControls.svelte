<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@yesid/ui/sheet';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import {
		frameHref,
		frameToday,
		parseFrameState,
		periodError,
		presetPeriod,
		PRESETS,
		RECORD_START,
		type FrameMode,
		type PeriodError,
	} from '#lib/site/frameState.ts';

	let { locale, url }: { locale: Locale; url: URL } = $props();

	const translations = {
		en: {
			view: 'View',
			live: 'Live',
			record: 'Record',
			period: 'Period',
			close: 'Close period picker',
			presets: [
				'Yesterday',
				'Last 7 complete days',
				'Last 28 complete days',
				'This month',
				'Last month',
			],
			custom: 'Custom dates',
			from: 'Start date',
			to: 'End date',
			apply: 'Apply dates',
			note: (date: string) => `The record starts on ${date}.`,
			scope: 'Current pages still use their own data and filters.',
			error: {
				invalidDate: 'Enter a valid start date and end date.',
				reversed: 'The end date must be on or after the start date.',
				beforeRecord: 'Choose dates on or after the start of the record.',
				future: 'Choose dates up to today.',
			},
		},
		fr: {
			view: 'Vue',
			live: 'En direct',
			record: 'Bilan',
			period: 'Période',
			close: 'Fermer le choix de la période',
			presets: [
				'Hier',
				'7 derniers jours complets',
				'28 derniers jours complets',
				'Ce mois-ci',
				'Le mois dernier',
			],
			custom: 'Dates personnalisées',
			from: 'Date de début',
			to: 'Date de fin',
			apply: 'Appliquer les dates',
			note: (date: string) => `Le bilan commence le ${date}.`,
			scope: 'Les pages actuelles utilisent encore leurs propres données et filtres.',
			error: {
				invalidDate: 'Saisissez une date de début et une date de fin valides.',
				reversed: 'La date de fin doit être égale ou postérieure à la date de début.',
				beforeRecord: 'Choisissez des dates à partir du début du bilan.',
				future: 'Choisissez des dates au plus tard aujourd’hui.',
			},
		},
	} as const;

	const uid = $props.id();
	const copy = $derived(translations[locale]);
	let today = $state(frameToday());
	const frame = $derived(parseFrameState(url.searchParams, today));
	const dates = $derived(intl.dateTime(locale, { timeZone: 'UTC', dateStyle: 'medium' }));
	const rangeLabel = $derived(
		frame.period ? dates.formatRange(new Date(frame.period.from), new Date(frame.period.to)) : '',
	);
	const modes = $derived([
		{ key: 'live' as const, label: copy.live },
		{ key: 'record' as const, label: copy.record },
	]);

	let open = $state(false);
	let start = $state('');
	let end = $state('');
	let error = $state<PeriodError | null>(null);

	function onOpenChange(next: boolean) {
		if (!next) return;
		today = frameToday();
		start = frame.period?.from ?? '';
		end = frame.period?.to ?? '';
		error = null;
	}

	function selectMode(mode: FrameMode) {
		if (frame.mode === mode) return;
		void goto(frameHref(url, { ...frame, mode }), { shallow: true, state: { ...page.state } });
	}

	function selectPeriod(period: NonNullable<typeof frame.period>) {
		open = false;
		void goto(frameHref(url, { ...frame, period }), { shallow: true, state: { ...page.state } });
	}

	function applyDates(event: SubmitEvent) {
		event.preventDefault();
		today = frameToday();
		const period = { from: start, to: end, preset: null };
		error = periodError(period, today);
		if (!error) selectPeriod(period);
	}
</script>

<SegmentedChoice options={modes} value={frame.mode} label={copy.view} onSelect={selectMode} />
<Sheet bind:open {onOpenChange}>
	<SheetTrigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="cta-sm" wrap class="min-h-11">
				{copy.period}<span class="frame-range">{rangeLabel ? ` · ${rangeLabel}` : ''}</span>
			</Button>
		{/snippet}
	</SheetTrigger>
	<SheetContent closeLabel={copy.close} class="overflow-y-auto p-4" data-lenis-prevent>
		<div class="mx-auto grid w-full max-w-xl gap-4 pr-8">
			<SheetTitle>{copy.period}</SheetTitle>
			<SheetDescription id={`${uid}-note`}>
				{copy.note(dates.format(new Date(RECORD_START)))}
				{copy.scope}
			</SheetDescription>
			<div class="flex flex-wrap gap-2" role="group" aria-label={copy.period}>
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
			<form class="grid gap-3" novalidate onsubmit={applyDates}>
				<fieldset class="flex flex-wrap gap-3">
					<legend class="mb-2">{copy.custom}</legend>
					<label class="grid gap-1">
						{copy.from}
						<input
							class="labelled-input min-h-11"
							type="date"
							bind:value={start}
							min={RECORD_START}
							max={today}
							required
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? `${uid}-error` : `${uid}-note`}
						/>
					</label>
					<label class="grid gap-1">
						{copy.to}
						<input
							class="labelled-input min-h-11"
							type="date"
							bind:value={end}
							min={RECORD_START}
							max={today}
							required
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? `${uid}-error` : `${uid}-note`}
						/>
					</label>
				</fieldset>
				{#if error}<p id={`${uid}-error`} role="alert">{copy.error[error]}</p>{/if}
				<Button type="submit" size="cta-sm" wrap class="min-h-11 justify-self-start"
					>{copy.apply}</Button
				>
			</form>
		</div>
	</SheetContent>
</Sheet>

<style>
	@container site-header (width < 600px) {
		.frame-range {
			display: none;
		}
	}
</style>
