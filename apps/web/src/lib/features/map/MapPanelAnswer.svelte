<script lang="ts">
	import { AnswerLead } from '@yesid/ui/brand';

	let { value, sentence }: { value: string; sentence: string } = $props();
</script>

<div class="[min-inline-size:0] [overflow-wrap:anywhere]" data-slot="screen-answer">
	<AnswerLead {value} {sentence} size="md" />
</div>
