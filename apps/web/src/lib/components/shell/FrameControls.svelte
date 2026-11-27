<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type { SurfaceRailContext } from '@yesid/ui/layout';

	export interface FrameControlsExtension {
		between?: Snippet;
		extra?: Snippet<[SurfaceRailContext]>;
		after?: Snippet;
		hideSummary?: () => boolean;
	}

	export const FrameControlsExtensionContext = Symbol('frame controls extension');
	export type RegisterFrameControlsExtension = (extension: FrameControlsExtension) => () => void;
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { ControlsRail, DateRangePicker } from '@yesid/ui/layout';
	import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@yesid/ui/sheet';
	import type { Locale } from '#lib/i18n/index.ts';
	import { longDate } from '#lib/site/presenter.ts';
	import {
		frameDateLimit,
		frameHref,
		MAX_RECORD_DAYS,
		parseFrameState,
		periodError,
		presetPeriod,
		PRESETS,
		RECORD_START,
		type FrameClock,
		type FrameMode,
		type Preset,
	} from '#lib/site/frameState.ts';
	import { frameCopy, framePeriodSummary, type frameControlsState } from './frameControlsState.ts';
	import LivePauseSwitch from './LivePauseSwitch.svelte';

	let {
		locale,
		url,
		clock,
		frame,
		context,
		extension,
	}: {
		locale: Locale;
		url: URL;
		clock: FrameClock;
		frame: ReturnType<typeof frameControlsState>;
		context: SurfaceRailContext;
		extension?: FrameControlsExtension;
	} = $props();

	const uid = $props.id();
	const copy = $derived(frameCopy[locale]);
	const { today, recordThrough } = $derived(clock);
	const dateLimit = $derived(frameDateLimit(clock));
	const summary = $derived(framePeriodSummary(frame.period, locale));
	const start = $derived(clock.recordStart ?? RECORD_START);
	const startLabel = $derived(longDate(start, locale));
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
			disabled: !presetPeriod(key, clock),
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
		// A view switch carries the requested dates so returning to Record can use a newly built day.
		const { period } = parseFrameState(url.searchParams, clock);
		const target = new URL(frameHref(url, { mode, period }), url);
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
		const period = presetPeriod(key, clock);
		if (period) selectPeriod(period);
	}

	function applyDates({ start, end }: { start: string; end: string }) {
		const period = { from: start, to: end, preset: null };
		tooLong = periodError(period, dateLimit, start) === 'tooLong';
		if (tooLong) return;
		open = false;
		selectPeriod(period);
	}
</script>

{#snippet viewContent()}
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
	{:else if frame.showViewHint}
		<p class="text-sm text-muted-foreground">{copy.viewHint[frame.mode]}</p>
	{/if}
	{#if frame.mode === 'live' && !frame.recordOnly}
		<LivePauseSwitch {locale} />
	{/if}
{/snippet}

<!-- Live shows View only (S5): dates apply to Record, so Live has no Period card. -->
{#snippet periodContent()}
	{#if !extension}<SegmentedChoice
			options={presets}
			value={frame.period?.preset ?? ''}
			label={copy.period}
			onSelect={selectPreset}
			variant="joined-grid"
		/>{/if}
	{#if recordThrough && recordThrough.slice(0, 7) < today.slice(0, 7)}
		<p class="w-full text-sm text-muted-foreground">{copy.waitingForMonth}</p>
	{/if}
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
				{#if extension}
					<SegmentedChoice
						options={presets}
						value={frame.period?.preset ?? ''}
						label={copy.period}
						onSelect={(key) => {
							open = false;
							selectPreset(key);
						}}
						variant="joined-grid"
					/>
				{/if}
				<DateRangePicker
					presets={[]}
					value={{ start: frame.period?.from ?? '', end: frame.period?.to ?? '' }}
					min={start}
					max={dateLimit}
					labels={{
						legend: copy.custom,
						presets: copy.period,
						custom: copy.custom,
						start: copy.from,
						end: copy.to,
						apply: copy.apply,
						missing: copy.missing,
						bounds: dateLimit === today ? copy.bounds : copy.completeBounds,
						order: copy.order,
					}}
					onValueChange={applyDates}
				/>
				{#if tooLong}<p role="alert">{copy.tooLong(MAX_RECORD_DAYS)}</p>{/if}
			</div>
		</SheetContent>
	</Sheet>
	<p class="w-full text-sm text-muted-foreground">{copy.note(startLabel)}</p>
{/snippet}

<div class="grid min-w-0 gap-3" data-frame-controls={context.presentation}>
	{#if extension}
		<ControlsRail
			label={copy.view}
			style="padding: calc(var(--spacing) * 2); gap: calc(var(--spacing) * 2);"
		>
			{@render viewContent()}
			{@render extension.between?.()}
			{#if frame.mode !== 'live'}
				<p class="w-full text-sm font-medium text-muted-foreground">{copy.period}</p>
				{@render periodContent()}
			{/if}
			{@render extension.extra?.(context)}
		</ControlsRail>
	{:else}
		<ControlsRail label={copy.view}>
			{@render viewContent()}
		</ControlsRail>
		{#if frame.mode !== 'live'}
			<ControlsRail label={copy.period}>
				{@render periodContent()}
			</ControlsRail>
		{/if}
	{/if}
</div>
