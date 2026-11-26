<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { dateRange } from '#lib/site/presenter.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import { setRecordPatience, setRecordRecovered, setRecordSlow } from './recordPatience.ts';

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
	// Each waiting card says it is still calculating, in its own place, so nothing above the
	// screen title appears or moves (the screen-wide notice is for screen readers only).
	setRecordSlow(() => (slow && pending > 0 ? stillCalculating : null));

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

	const waiting = $derived(busy > 0 || (slow && pending > 0));
	const dates = $derived(period ? dateRange(period, locale) : null);
	const french = $derived(locale === 'fr');
	const stillCalculating = $derived(
		dates
			? french
				? `Le calcul du bilan pour la période ${dates} se poursuit.`
				: `Still calculating the record for ${dates}.`
			: french
				? 'Le calcul du bilan se poursuit.'
				: 'Still calculating the record.',
	);
	const reading = $derived(
		dates
			? french
				? `Lecture du bilan pour la période ${dates}.`
				: `Reading the record for ${dates}.`
			: french
				? 'Lecture du bilan en cours.'
				: 'Reading the record.',
	);
</script>

{#if waiting || answered || recovered}
	<div class="sr-only" data-slot="record-patience">
		<p role="status">
			{waiting
				? french
					? 'Ce bilan demande plus de temps.'
					: 'These records take longer.'
				: french
					? 'Lectures reçues.'
					: 'Readings arrived.'}
			{waiting
				? `${reading} ${
						french
							? 'Chaque carte se remplit dès que sa réponse arrive.'
							: 'Each card fills in when its answer arrives.'
					}`
				: french
					? 'Les lectures qui tardaient sont maintenant affichées.'
					: 'The readings that took longer are now on screen.'}
		</p>
	</div>
{/if}
{@render children()}
