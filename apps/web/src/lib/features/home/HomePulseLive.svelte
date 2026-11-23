<script lang="ts">
	import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
	import { onMount, untrack } from 'svelte';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { FreshnessStamp } from '#lib/components/surface/index.ts';
	import { refreshMessage, type RefreshResult } from '#lib/components/shell/refreshResult.ts';
	import { fmtCount } from '#lib/utils/index.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { livePresentation } from '#lib/v1/live/livePresentation.ts';
	import { LIVE_FAMILIES, createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import { stampText } from '#lib/v1/stamp.ts';
	import { selectLivePulse } from './homePulse';
	import type { HomePulseCopy } from './homePulse.copy';

	interface Props {
		readonly locale: Locale;
		/** Absent before the data context boots: the card keeps its shape and its link. */
		readonly manifest: Manifest | null;
		readonly copy: HomePulseCopy;
	}

	let { locale, manifest, copy: t }: Props = $props();
	const localizeHref = getLocalizeHref();
	const v1 = getV1Context(true);
	const timeZone = $derived(v1?.provider?.timezone ?? manifest?.tz);

	// The provider is fixed for this page's lifetime; switching cities remounts the page.
	const live = untrack(() =>
		manifest ? createLiveStore(manifest, liveReader, { families: ['network'] }) : null,
	);
	onMount(() => {
		live?.start();
		return () => live?.stop();
	});

	const pulse = $derived(selectLivePulse(live?.network ?? null));
	const failed = $derived(live?.familyStates.network.health.state === 'failed-no-data' && !pulse);
	const presentation = $derived(
		live
			? livePresentation({
					familyStates: live.familyStates,
					families: LIVE_FAMILIES,
					timeZone,
					locale,
					page: 'network',
					networkFeedAgeAtPublication: live.network?.feed_freshness_s ?? null,
				})
			: null,
	);

	let refreshing = false;
	let result = $state<RefreshResult | null>(null);
	async function refresh(): Promise<void> {
		if (!live || refreshing) return;
		refreshing = true;
		result = null;
		const shownAtMs = Date.parse(live.network?.generated_utc ?? '');
		try {
			await live.refresh({ force: true });
			result = { kind: 'updated', atMs: Date.now() };
		} catch {
			result = { kind: 'failed', shownAtMs: Number.isFinite(shownAtMs) ? shownAtMs : Date.now() };
		} finally {
			refreshing = false;
		}
	}

	const count = (value: number | null | undefined) =>
		value == null ? null : (fmtCount(value, { locale }) ?? null);
	// French names 0 and 1 in the singular, English only 1.
	const one = (value: number | null | undefined) =>
		value != null && (locale === 'fr' ? value < 2 : value === 1);
	const counts = $derived([
		{
			key: 'reporting',
			value: count(pulse?.reporting),
			label: one(pulse?.reporting) ? t.reportingOne : t.reporting,
			reserve: t.reporting,
			note: null,
		},
		{
			key: 'silent',
			value: count(pulse?.silent),
			label: one(pulse?.silent) ? t.silentOne : t.silent,
			reserve: t.silent,
			note: one(pulse?.silent) ? t.silentNoteOne : t.silentNote,
		},
	]);
	// The longest stamp this card can show: before the first reading, or long behind.
	const stampReserve = $derived(
		[
			...(['unknown', 'behind'] as const).map((state) =>
				stampText(
					{ form: 'live', subject: 'data', state, ageSeconds: 3_540, generatedUtc: null },
					locale,
					timeZone,
				),
			),
			t.liveUnavailable,
		].reduce((a, b) => (b.length > a.length ? b : a)),
	);
	// The longest result Refresh can say, at a two-digit hour, so saying it moves nothing below.
	const resultReserve = $derived.by(() => {
		const atMs = Date.parse('2026-11-15T12:59:00Z');
		return [
			refreshMessage({ kind: 'updated', atMs }, locale, 'UTC'),
			refreshMessage({ kind: 'failed', shownAtMs: atMs }, locale, 'UTC'),
		].reduce((a, b) => (b.length > a.length ? b : a));
	});
</script>

<section class="home-live" data-slot="home-pulse-live" aria-labelledby="home-live-title">
	<h2 id="home-live-title">{transitTerms[locale].liveNow}</h2>
	<div class="live-head">
		<div class="slot live-stamp">
			{#if failed}
				<p class="live-absent" role="status">{t.liveUnavailable}</p>
			{:else if presentation}
				<p><FreshnessStamp variant="live" presentation={presentation.stamp} {locale} /></p>
			{/if}
			<p class="reserve" aria-hidden="true" data-reserve={stampReserve}></p>
		</div>
		<button type="button" class="live-refresh" onclick={refresh} disabled={!live}>
			<RefreshIcon size={16} strokeWidth={1.8} aria-hidden="true" />
			{t.refresh}
		</button>
	</div>
	<div class="slot live-result" data-failed={result?.kind === 'failed'}>
		<p aria-live="polite">
			{#if result}{refreshMessage(result, locale, timeZone)}{/if}
		</p>
		<p class="reserve" aria-hidden="true" data-reserve={resultReserve}></p>
	</div>
	<ul class="live-counts" aria-busy={!pulse && !failed}>
		{#each counts as item (item.key)}
			<li data-live={item.key}>
				<span class="live-n">
					{#if item.value != null}{item.value}{:else}<span aria-hidden="true">—</span
						>{#if pulse || failed}<span class="sr-only">{t.unavailable}</span>{/if}{/if}
				</span>
				<span class="live-t">
					<span class="slot">
						<span>{item.label}</span>
						<span class="reserve" aria-hidden="true" data-reserve={item.reserve}></span>
					</span>
					{#if item.note}<span class="live-note">{item.note}</span>{/if}
				</span>
			</li>
		{/each}
	</ul>
	<p class="home-card-actions">
		<a class="home-card-action" href={localizeHref(routeFor({ kind: 'map' }), locale)}
			>{t.openMap}</a
		>
	</p>
</section>

<style>
	.home-live p {
		margin: 0;
	}
	/* The stamp takes the card's full width so it wraps as little as it can; Refresh sits under it. */
	.live-head {
		display: grid;
		justify-items: start;
		gap: 0.25rem;
	}
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
	.reserve::after {
		content: attr(data-reserve);
	}
	.live-stamp {
		justify-self: stretch;
		min-height: 44px;
		align-content: center;
		font-size: var(--text-small);
		line-height: 1.5;
	}
	/* A flex wrapper: an inline stamp would add line-box space the reserve does not have. */
	.live-stamp > p {
		display: flex;
	}
	/* The dot stays beside the stamp's first line; the words wrap under themselves. */
	.live-stamp :global(.freshness-stamp) {
		flex-wrap: nowrap;
		align-items: flex-start;
	}
	.live-stamp :global(.freshness-stamp > :first-child) {
		margin-top: calc(0.5lh - 3px);
	}
	.live-stamp .reserve {
		padding-left: calc(6px + 0.5rem);
		font-family: var(--font-mono);
	}
	.live-absent {
		color: var(--secondary-foreground);
	}
	.live-refresh {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 44px;
		padding: 0 0.25rem;
		color: var(--primary);
		font: inherit;
		font-weight: 600;
		background: none;
		border: 0;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	.live-refresh:hover {
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.live-refresh:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}
	.live-refresh:disabled {
		color: var(--muted-foreground);
		cursor: default;
		text-decoration: none;
	}
	.live-result {
		font-size: var(--text-small);
		line-height: 1.5;
		color: var(--secondary-foreground);
	}
	.live-result[data-failed='true'] {
		color: var(--foreground);
	}
	.live-counts {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.live-counts li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		column-gap: 0.75rem;
		align-items: baseline;
	}
	/* A fixed figure column: the labels wrap the same before and after the numbers arrive. */
	.live-n {
		min-inline-size: 5ch;
		font-family: var(--font-heading);
		font-size: var(--text-heading);
		font-weight: 800;
		line-height: 1.1;
		text-align: end;
		font-variant-numeric: tabular-nums;
		color: var(--foreground);
	}
	.live-t {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		line-height: 1.4;
	}
	.live-note {
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
</style>
