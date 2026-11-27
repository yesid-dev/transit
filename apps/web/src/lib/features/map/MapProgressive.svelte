<script module lang="ts">
	import type { Component } from 'svelte';

	export interface ProgressiveMapFailure {
		readonly kind: string;
		readonly retry: () => Promise<void>;
	}

	export interface ProgressiveMapHeroProps {
		onready?: () => void;
		onidle?: () => void;
		oninitialdata?: (settled: boolean) => void;
		controlsVisible?: boolean;
		onrecovering?: () => void;
		onfailure?: (failure: ProgressiveMapFailure | null) => void;
	}

	export type ProgressiveMapHeroModule = {
		default: Component<ProgressiveMapHeroProps>;
	};
</script>

<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { getContext, onDestroy, onMount } from 'svelte';
	import { getLocale } from '#lib/i18n/index.ts';
	import { theme } from '@yesid/ui/state';
	import { INITIAL_MAP_GLYPHS } from '#lib/components/map/mapGlyphs.ts';
	import { prefersReducedMotion } from '@yesid/motion/stores/reducedMotion';
	import { mapCopy } from './map.copy';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { mapSourceCreditContext } from '#lib/site/mapRecordSourceDate.ts';
	import {
		mapControlsVisibilityContext,
		type RegisterMapControlsVisibility,
	} from '#lib/components/shell/mapControlsVisibility.ts';

	interface Props {
		importHero?: () => Promise<ProgressiveMapHeroModule>;
		record?: boolean;
	}

	let { importHero, record = false }: Props = $props();

	type ProgressiveState = 'static' | 'booting' | 'ready' | 'failed';
	const locale = getLocale();
	const v1 = getV1Context();
	const sourceCredit = getContext<(() => string) | undefined>(mapSourceCreditContext);
	const city = v1.provider?.labels[locale].city ?? v1.manifest.city ?? v1.manifest.provider;
	const t = $derived(mapCopy(locale, city));
	const receipts = import.meta.glob<{
		provider_id: string;
		posters: Array<{ filename: string; theme: string; width: number }>;
	}>('/static/map/*-posters.json', { eager: true, import: 'default' });
	const selected = receipts[`/static${v1.provider?.posters_url}`];
	const receipt = selected?.provider_id === v1.manifest.provider ? selected : undefined;
	const posterTheme = $derived(theme.current);
	const posterMobile = $derived(
		receipt?.posters.find((p) => p.theme === posterTheme && p.width === 390),
	);
	const posterDesktop = $derived(
		receipt?.posters.find((p) => p.theme === posterTheme && p.width === 1280),
	);
	let posterFailed = $state(false);
	const hasPoster = $derived(Boolean(posterMobile && posterDesktop && !posterFailed));

	let root = $state<HTMLDivElement | null>(null);
	let phase = $state<ProgressiveState>('static');
	const registerControls = getContext<RegisterMapControlsVisibility | undefined>(
		mapControlsVisibilityContext,
	);
	$effect(() => registerControls?.(() => phase === 'ready'));
	let LiveMap = $state.raw<ProgressiveMapHeroModule['default'] | null>(null);
	let importPending: Promise<void> | null = null;
	let liveFailure: ProgressiveMapFailure | null = null;
	let liveRetryPending = $state(false);
	let attempt = $state(0);
	let readyTime = $state<number | null>(null);
	let idleTime = $state<number | null>(null);
	let initialDataSettled = $state(false);
	let idleAttempt = 0;
	let alive = true;

	onMount(startImport);

	onDestroy(() => {
		alive = false;
	});

	function clock(): number {
		return typeof performance === 'undefined' ? 0 : performance.now();
	}

	function publish(type: string, time: number): void {
		root?.dispatchEvent(
			new CustomEvent(type, {
				bubbles: true,
				detail: { attempt, time },
			}),
		);
	}

	function beginAttempt(): void {
		attempt += 1;
		readyTime = null;
		idleTime = null;
		idleAttempt = 0;
		phase = 'booting';
	}

	function startImport(): void {
		if (importPending || LiveMap || phase === 'booting') return;
		beginAttempt();
		liveFailure = null;
		const activeAttempt = attempt;
		let heroImport: Promise<ProgressiveMapHeroModule>;
		try {
			heroImport = importHero ? importHero() : import('./MapHero.svelte');
		} catch {
			if (alive && attempt === activeAttempt) phase = 'failed';
			return;
		}
		const pending = heroImport
			.then((module) => {
				if (!alive || attempt !== activeAttempt) return;
				LiveMap = module.default;
			})
			.catch(() => {
				if (!alive || attempt !== activeAttempt) return;
				phase = 'failed';
			})
			.finally(() => {
				if (importPending === pending) importPending = null;
			});
		importPending = pending;
	}

	function handleReady(): void {
		if (phase !== 'booting' || readyTime !== null) return;
		readyTime = clock();
		publish('transit:map-ready', readyTime);
	}

	function handleIdle(): void {
		if (idleAttempt === attempt || phase !== 'booting' || readyTime === null) return;
		idleAttempt = attempt;
		idleTime = clock();
		publish('transit:maplibre-idle', idleTime);
	}

	$effect(() => {
		if (phase === 'booting' && idleTime !== null && initialDataSettled) phase = 'ready';
	});

	function handleRecovering(): void {
		if (!LiveMap || phase === 'failed') return;
		beginAttempt();
	}

	function handleFailure(failure: ProgressiveMapFailure | null): void {
		liveFailure = failure;
		if (failure) phase = 'failed';
		else if (LiveMap) phase = 'booting';
	}

	function retry(): void {
		if (phase !== 'failed' || liveRetryPending) return;
		if (!liveFailure) {
			LiveMap = null;
			startImport();
			return;
		}

		const retryFailure = liveFailure;
		liveRetryPending = true;
		beginAttempt();
		const activeAttempt = attempt;
		let retryResult: Promise<void>;
		try {
			retryResult = retryFailure.retry();
		} catch {
			phase = 'failed';
			liveRetryPending = false;
			return;
		}
		void retryResult
			.catch(() => {
				if (alive && attempt === activeAttempt) phase = 'failed';
			})
			.finally(() => {
				liveRetryPending = false;
			});
	}
</script>

<svelte:head>
	{#if v1.manifest.basemap}
		{#each INITIAL_MAP_GLYPHS as href (href)}
			<link rel="preload" as="fetch" crossorigin="anonymous" {href} />
		{/each}
	{/if}
</svelte:head>

<div
	class="map-progressive"
	data-ripple-exempt
	data-testid="map-progressive"
	data-map-progressive-state={phase}
	data-map-attempt={attempt}
	data-map-ready-time={readyTime ?? undefined}
	data-map-idle-time={idleTime ?? undefined}
	bind:this={root}
>
	<div
		class="map-progressive-live"
		data-testid="map-progressive-live"
		data-visible={phase === 'ready'}
		aria-hidden={phase === 'ready' ? undefined : 'true'}
		inert={phase === 'ready' ? undefined : true}
		style:transition={$prefersReducedMotion ? 'none' : undefined}
	>
		{#if LiveMap}
			<LiveMap
				onready={handleReady}
				onidle={handleIdle}
				oninitialdata={(settled) => (initialDataSettled = settled)}
				controlsVisible={phase === 'ready'}
				onrecovering={handleRecovering}
				onfailure={handleFailure}
			/>
		{/if}
	</div>

	<section
		class="map-progressive-poster"
		data-slot="map-static"
		data-record-poster={record ? '' : undefined}
		data-testid="map-progressive-poster"
		data-visible={phase !== 'ready'}
		aria-hidden={phase === 'ready' ? 'true' : undefined}
		inert={phase === 'ready' ? true : undefined}
		aria-labelledby="map-progressive-heading"
		style:transition={$prefersReducedMotion ? 'none' : undefined}
	>
		{#if hasPoster}
			<picture class="map-progressive-picture">
				<source
					media="(min-width: 1024px)"
					type="image/avif"
					srcset={`/map/${posterDesktop!.filename}`}
					width="1280"
					height="720"
				/>
				<img
					src={`/map/${posterMobile!.filename}`}
					onerror={() => (posterFailed = true)}
					width="390"
					height="844"
					alt=""
					fetchpriority="high"
					decoding="async"
				/>
			</picture>
		{/if}
		<div class="map-progressive-shade" aria-hidden="true"></div>

		{#if phase !== 'ready'}
			<div class="map-progressive-copy">
				<h1 id="map-progressive-heading">
					{record ? t.recordPoster.title : t.bootHeading}
				</h1>
				<p class="map-progressive-status" role="status" aria-live="polite">
					{phase === 'booting' ? (record ? t.recordPoster.loading : t.mapBooting) : ''}
				</p>

				{#if phase === 'failed'}
					<div class="map-progressive-failure" role="alert">
						<p>{record ? t.recordPoster.failed : t.mapImportError}</p>
						<Button
							type="button"
							size="sm"
							class="mt-4 min-h-11"
							disabled={liveRetryPending}
							onclick={retry}>{record ? t.recordPoster.retry : t.mapImportRetry}</Button
						>
					</div>
				{/if}
			</div>

			<p class="map-progressive-attribution">
				<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>
				<span aria-hidden="true"> · </span>
				<a href="https://github.com/protomaps/basemaps">© Protomaps</a>
				{#if sourceCredit}<span class="poster-mobile-credit">{sourceCredit()}</span>{/if}
			</p>

			<noscript
				><p class="map-progressive-noscript">
					{record ? t.recordPoster.noScript : t.staticNoScript}
				</p></noscript
			>
		{/if}
	</section>
</div>

<style>
	.map-progressive {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: var(--background);
	}

	.map-progressive-live,
	.map-progressive-poster {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		transition: opacity var(--duration-normal) var(--ease-out);
	}

	.map-progressive-live {
		z-index: 1;
		visibility: hidden;
		opacity: 0;
	}

	.map-progressive-live[data-visible='true'] {
		z-index: 3;
		visibility: visible;
		opacity: 1;
	}

	.map-progressive-poster {
		z-index: 2;
		margin: 0;
		overflow: hidden;
		opacity: 1;
		color: var(--reflective);
		background: var(--background);
	}

	.map-progressive-poster[data-visible='false'] {
		opacity: 0;
		pointer-events: none;
	}

	.map-progressive-picture,
	.map-progressive-picture img {
		display: block;
		width: 100%;
		height: 100%;
	}

	.map-progressive-picture img {
		object-fit: cover;
	}

	.map-progressive-shade {
		position: absolute;
		inset: 0;
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--hazard-b) 10%, transparent) 30%,
				color-mix(in srgb, var(--hazard-b) 88%, transparent) 100%
			),
			linear-gradient(
				90deg,
				color-mix(in srgb, var(--hazard-b) 58%, transparent) 0%,
				transparent 68%
			);
	}

	.map-progressive-copy {
		position: absolute;
		z-index: 1;
		left: clamp(1rem, 4vw, 3.5rem);
		bottom: clamp(4.5rem, 10vh, 7rem);
		width: min(34rem, calc(100% - 2rem));
	}

	h1 {
		margin: 0;
		font-size: var(--text-display);
		font-weight: 700;
		line-height: 0.98;
		letter-spacing: var(--tracking-tight);
	}

	.map-progressive-status,
	.map-progressive-failure {
		margin: 1rem 0 0;
		font-weight: 700;
	}

	.map-progressive-failure p {
		margin: 0;
	}

	.map-progressive-attribution,
	.map-progressive-noscript {
		position: absolute;
		z-index: 1;
		right: 0.65rem;
		bottom: 0.55rem;
		margin: 0;
		padding: 0.28rem 0.42rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--hazard-b) 78%, transparent);
		font-size: 0.68rem;
		line-height: 1.35;
	}

	.map-progressive-attribution a {
		color: var(--reflective);
		text-decoration: underline;
		text-underline-offset: 0.14em;
	}
	.poster-mobile-credit {
		display: none;
	}
	[data-record-poster] .map-progressive-attribution {
		bottom: calc(var(--map-source-clearance, 0px) + 0.55rem);
	}

	.map-progressive-noscript {
		left: 0.65rem;
		right: auto;
		bottom: 0.55rem;
		max-width: min(var(--measure-lede), calc(100% - 1.3rem));
	}

	@media (prefers-reduced-motion: reduce) {
		.map-progressive-live,
		.map-progressive-poster {
			transition: none;
		}
	}

	@media (--tablet-max) {
		.map-progressive-copy {
			bottom: calc(var(--map-source-clearance, 0px) + 5.5rem);
		}

		.map-progressive-attribution {
			left: 0.65rem;
			right: auto;
			max-width: calc(100% - 1.3rem);
		}

		.map-progressive-noscript {
			bottom: 2.25rem;
		}
	}
	@media (width < 1024px) {
		.poster-mobile-credit {
			display: block;
		}
	}
</style>
