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
			},
		},
	} as const;

	const uid = $props.id();
	const copy = $derived(translations[locale]);
	let today = $state(frameToday());
	const frame = $derived(parseFrameState(url.searchParams, today));
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
				{copy.scope}
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
