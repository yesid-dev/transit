<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { ControlsRail, DateRangePicker, type SurfaceRailContext } from '@yesid/ui/layout';
	import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@yesid/ui/sheet';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import {
		frameHref,
		MAX_RECORD_DAYS,
		periodError,
		presetPeriod,
		PRESETS,
		RECORD_START,
		type FrameMode,
		type Preset,
	} from '#lib/site/frameState.ts';
	import { frameCopy, framePeriodSummary, type frameControlsState } from './frameControlsState.ts';

	let {
		locale,
		url,
		today,
		frame,
		context,
	}: {
		locale: Locale;
		url: URL;
		today: string;
		frame: ReturnType<typeof frameControlsState>;
		context: SurfaceRailContext;
	} = $props();

	const uid = $props.id();
	const copy = $derived(frameCopy[locale]);
	const summary = $derived(framePeriodSummary(frame.period, locale));
	const startLabel = $derived(
		intl.dateTime(locale, { timeZone: 'UTC', dateStyle: 'long' }).format(new Date(RECORD_START)),
	);
	const modes = $derived([
		{
			key: 'live' as const,
			label: copy.live,
			disabled: frame.recordOnly,
			describedById: frame.recordOnly ? uid : undefined,
		},
		{
			key: 'record' as const,
			label: copy.record,
			disabled: frame.recordOnly || frame.liveOnly,
			describedById: frame.liveOnly ? uid : undefined,
		},
	]);
	const presets = $derived(
		PRESETS.map((key) => ({
			key,
			label: copy.presets[key],
			disabled: !presetPeriod(key, today),
		})),
	);
	let open = $state(false);
	let tooLong = $state(false);

	async function navigate(href: string | URL, shallow: boolean) {
		// SegmentedChoice moves focus after onSelect when the reader uses an arrow key.
		await tick();
		const focused = document.activeElement;
		await goto(href, { shallow, reset: false, state: { ...page.state } });
		// The header's eventless navigation fallback can restore focus to the body.
		if (
			focused instanceof HTMLElement &&
			focused.isConnected &&
			document.activeElement === document.body
		) {
			focused.focus({ preventScroll: true });
		}
	}

	function selectMode(mode: FrameMode) {
		if (frame.mode === mode) return;
		const target = new URL(frameHref(url, { ...frame, mode }), url);
		if (frame.detail) {
			if (mode === 'live') target.searchParams.set('tab', 'detail');
			else target.searchParams.delete('tab');
		}
		if (frame.map) {
			if (mode === 'live') target.searchParams.delete('mapLayer');
			else target.searchParams.set('mapLayer', 'stops');
		}
		void navigate(target, !frame.usesFrameRecord && !frame.map);
	}

	function selectPeriod(period: NonNullable<typeof frame.period>) {
		void navigate(
			frameHref(url, { ...frame, period }),
			!frame.map && (!frame.usesFrameRecord || frame.mode === 'live'),
		);
	}

	function selectPreset(key: Preset | '') {
		if (!key) return;
		const period = presetPeriod(key, today);
		if (period) selectPeriod(period);
	}

	function applyDates({ start, end }: { start: string; end: string }) {
		const period = { from: start, to: end, preset: null };
		tooLong = periodError(period, today) === 'tooLong';
		if (tooLong) return;
		open = false;
		selectPeriod(period);
	}
</script>

<div class="grid min-w-0 gap-3" data-frame-controls={context.presentation}>
	<ControlsRail label={copy.view}>
		<SegmentedChoice
			options={modes}
			value={frame.mode}
			label={copy.view}
			onSelect={selectMode}
			variant="fit-row"
		/>
		{#if frame.recordOnly}
			<p id={uid} class="text-sm text-muted-foreground">{copy.recordOnly}</p>
		{:else if frame.liveOnly}
			<p id={uid} class="text-sm text-muted-foreground">{copy.liveOnly}</p>
		{/if}
	</ControlsRail>
	<ControlsRail label={copy.period} class="px-2!">
		{#if frame.mode === 'live'}
			<p class="w-full text-sm">
				<strong class="block">{copy.recordDates}</strong>
				<span class="text-muted-foreground">{copy.liveMoment}</span>
			</p>
		{:else}
			<SegmentedChoice
				options={presets}
				value={frame.period?.preset ?? ''}
				label={copy.period}
				onSelect={selectPreset}
				variant="joined-grid"
			/>
			{#if summary}
				<p class="w-full text-sm" data-slot="frame-period-summary">
					{#if summary.title}<strong class="block">{summary.title}</strong>{/if}
					<span>{summary.dates} · {summary.duration}</span>
				</p>
			{/if}
			<Sheet
				bind:open
				onOpenChange={(value) => {
					if (value) tooLong = false;
				}}
			>
				<SheetTrigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="cta-sm" wrap class="min-h-11 max-w-full">
							{copy.custom}
						</Button>
					{/snippet}
				</SheetTrigger>
				<SheetContent closeLabel={copy.close} class="overflow-y-auto p-4" data-lenis-prevent>
					<div class="mx-auto grid w-full max-w-xl gap-4 pr-8">
						<SheetTitle>{copy.period}</SheetTitle>
						<SheetDescription>{copy.note(startLabel)}</SheetDescription>
						<DateRangePicker
							presets={[]}
							value={{ start: frame.period?.from ?? '', end: frame.period?.to ?? '' }}
							min={RECORD_START}
							max={today}
							labels={{
								legend: copy.custom,
								presets: copy.period,
								custom: copy.custom,
								start: copy.from,
								end: copy.to,
								apply: copy.apply,
								missing: copy.missing,
								bounds: copy.bounds,
								order: copy.order,
							}}
							onValueChange={applyDates}
						/>
						{#if tooLong}<p role="alert">{copy.tooLong(MAX_RECORD_DAYS)}</p>{/if}
					</div>
				</SheetContent>
			</Sheet>
		{/if}
		<p class="w-full text-sm text-muted-foreground">{copy.note(startLabel)}</p>
	</ControlsRail>
</div>
