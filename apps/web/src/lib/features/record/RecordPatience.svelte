<script lang="ts">
	import type { Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from '@yesid/ui/button';
	import { StateNotice } from '@yesid/ui/feedback';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import { setRecordPatience, setRecordRecovered, setRecordRetry } from './recordPatience.ts';
	import { recordConnection } from './recordText.ts';
	import { screenWaitingWords } from './recordWaiting.ts';

	let {
		locale,
		period,
		scope,
		children,
	}: {
		locale: Locale;
		period: DateWindow | null;
		scope: string;
		children: Snippet;
	} = $props();

	let pending = $state(0);
	let busy = $state(0);
	let slow = $state(false);
	let answered = $state(false);
	let recovered = $state(false);
	let succeeded = false;
	let failed = false;

	setRecordPatience((waitingForSlot) => {
		if (waitingForSlot) busy += 1;
		else {
			if (pending === 0) {
				succeeded = false;
				failed = false;
				answered = false;
			}
			pending += 1;
		}
		return (success) => {
			if (waitingForSlot) busy -= 1;
			else pending -= 1;
			succeeded ||= success === true;
			failed ||= success === false;
			if (pending === 0) {
				answered = busy === 0 && slow && succeeded && !failed;
				slow = false;
			}
		};
	});

	setRecordRecovered(() => {
		if (busy === 0) return;
		recovered = true;
	});
	// Readings that could not arrive after the last try: the screen offers one "Try again".
	const retries = new SvelteSet<() => void>();
	setRecordRetry((retry) => {
		retries.add(retry);
		return () => retries.delete(retry);
	});
	function tryAgain() {
		for (const retry of [...retries]) retry();
	}

	$effect(() => {
		void scope;
		slow = false;
		answered = false;
		recovered = false;
	});

	$effect(() => {
		if (!pending || slow) return;
		const timer = setTimeout(() => (slow = true), 3_000);
		return () => clearTimeout(timer);
	});

	// One live region for the screen; each waiting card shows its own words under its shape.
	const loading = $derived(pending > 0 || busy > 0);
	const stage = $derived(
		busy > 0 || (slow && pending > 0) ? 'still' : loading ? 'loading' : 'done',
	);
	const french = $derived(locale === 'fr');
</script>

{#if loading || answered || recovered}
	<div class="sr-only" data-slot="record-patience">
		<p role="status">{screenWaitingWords(stage, locale, period)}</p>
	</div>
{/if}
{@render children()}
{#if retries.size}
	<div class="try-again" data-slot="record-try-again">
		<StateNotice
			role="status"
			presentation="card"
			tone="warning"
			title={recordConnection.unreachable[locale]}
		>
			{#snippet action()}
				<Button type="button" size="sm" class="min-h-11 min-w-11" onclick={tryAgain}>
					{french ? 'Réessayer' : 'Try again'}
				</Button>
			{/snippet}
		</StateNotice>
	</div>
{/if}

<style>
	/* One notice for the screen, kept in view at the foot of the window: nothing above moves. */
	.try-again {
		position: sticky;
		inset-block-end: max(var(--space-card-gap), env(safe-area-inset-bottom));
		z-index: 1;
		margin-block-start: var(--space-card-gap);
	}
</style>
