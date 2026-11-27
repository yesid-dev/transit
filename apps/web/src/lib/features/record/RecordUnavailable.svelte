<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import type { Locale } from '#lib/i18n/index.ts';
	import { recordConnection } from './recordText.ts';

	let { locale, retry }: { locale: Locale; retry?: () => void } = $props();
</script>

<p>{recordConnection.unreachable[locale]}</p>
{#if retry}
	<div>
		<Button type="button" size="sm" class="min-h-11 min-w-11" onclick={retry}>
			{locale === 'fr' ? 'Réessayer' : 'Try again'}
		</Button>
	</div>
{/if}
