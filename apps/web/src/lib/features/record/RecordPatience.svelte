<script lang="ts">
	import type { Snippet } from 'svelte';
	import { StateNotice } from '@yesid/ui/feedback';
	import type { Locale } from '#lib/i18n/index.ts';
	import { dateRange } from '#lib/site/presenter.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import { setRecordPatience } from './recordPatience.ts';

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

	$effect(() => {
		void scope;
		slow = false;
		answered = false;
	});

	$effect(() => {
		if (!pending || slow) return;
		const timer = setTimeout(() => (slow = true), 3_000);
		return () => clearTimeout(timer);
	});

	const waiting = $derived(busy > 0 || (slow && pending > 0));
	const dates = $derived(period ? dateRange(period, locale) : null);
	const french = $derived(locale === 'fr');
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

{#if waiting || answered}
	<div class="mx-auto w-full max-w-5xl px-4 pt-3" data-slot="record-patience">
		<StateNotice
			role="status"
			presentation="card"
			tone={waiting ? 'neutral' : 'positive'}
			title={waiting
				? french
					? 'Ce bilan demande plus de temps'
					: 'These records take longer'
				: french
					? 'Réponse prête'
					: 'Answered'}
			body={waiting
				? `${reading} ${
						french
							? 'Les résultats déjà affichés restent visibles. Si des lectures manquent, vous pouvez revenir à ce lien plus tard.'
							: 'Completed readings stay visible. If readings are still missing, you can return to this link later.'
					}`
				: french
					? 'La réponse est conservée.'
					: 'The answer is kept.'}
		/>
	</div>
{/if}
{@render children()}
