<script lang="ts">
	import { Skeleton } from '@yesid/ui/skeleton';
	import type { Locale } from '#lib/i18n/index.ts';
	import { alertFilterLayout } from './alertFilterLayout.ts';

	let { locale }: { locale: Locale } = $props();
	const t = (en: string, fr: string) => (locale === 'fr' ? fr : en);
</script>

<!-- Holds the filter row's place above the waiting notices. -->
<div class={alertFilterLayout.bar} aria-hidden="true" data-slot="alert-filters-waiting">
	{#each [t('Line', 'Ligne'), t('Stop', 'Arrêt')] as label (label)}
		<div class={alertFilterLayout.field}>
			<p class="text-small text-muted-foreground">{label}</p>
			<Skeleton class="h-11 w-full" />
		</div>
	{/each}
	<div class={alertFilterLayout.summary}>
		<Skeleton class="h-4 w-20" />
		<Skeleton class="h-11 w-16" />
	</div>
</div>
