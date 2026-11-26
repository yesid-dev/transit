<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose } from '../recordText.ts';

	let {
		table = $bindable(false),
		controls,
		locale,
	}: {
		table?: boolean;
		controls: string;
		locale: Locale;
	} = $props();
</script>

<!-- One name for what it does, and its state: "Table, pressed" while the table shows. -->
<Button
	class="min-h-11 w-fit"
	size="cta-sm"
	variant="outline"
	aria-controls={controls}
	aria-pressed={table}
	onclick={() => (table = !table)}
>
	{choose(locale, 'Table', 'Tableau')}
</Button>
