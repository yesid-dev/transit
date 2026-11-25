import { SvelteURLSearchParams } from 'svelte/reactivity';
import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';
import { getRecordRecovered } from './recordPatience.ts';

const RECOVERY_DELAY_MS = 60_000;
const extraReadings = ['days', 'network', 'networkDaily'] as const;
type Answer = Promise<EngineResult<RecordAnswer>>;
type RecordReadings = {
	sections: { section: string; answer: Answer }[];
	days?: Answer | null;
	network?: Answer | null;
	networkDaily?: Answer | null;
};
type RecoveryQuery = DateWindow & {
	kind: 'line' | 'vehicle';
	id: string;
	city: string;
	direction?: '0' | '1' | null;
};

export function recoverRecord<T extends RecordReadings>(
	getRecord: () => T | null | undefined,
	getQuery: (record: T) => RecoveryQuery | null,
) {
	const recordRecovered = getRecordRecovered();
	let recovered = $state.raw<{ initial: T; answers: Record<string, Answer | undefined> } | null>(
		null,
	);

	$effect(() => {
		const current = getRecord();
		const query = current && getQuery(current);
		if (!current || !query) return;
		const initial: T = current;
		const { city, kind, id, from, to, direction } = query;
		const readings: Record<string, Answer> = Object.fromEntries(
			initial.sections.map(({ section, answer }) => [section, answer]),
		);
		for (const key of extraReadings) {
			const answer = initial[key];
			if (answer) readings[key] = answer;
		}

		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let eligibleAt = Infinity;
		let waiting: string[] = [];
		let tried = false;
		function schedule() {
			clearTimeout(timer);
			if (tried || controller.signal.aborted || document.hidden || !waiting.length) return;
			timer = setTimeout(
				() => {
					if (document.hidden) return;
					tried = true;
					const params = new SvelteURLSearchParams({
						city,
						kind,
						id,
						from,
						to,
						sections: waiting.join(','),
					});
					if (direction) params.set('direction', direction);
					void fetch(`/api/record-recovery?${params}`, { signal: controller.signal })
						.then(async (response) => {
							if (!response.ok) return;
							const results: Record<string, EngineResult<RecordAnswer> | undefined> =
								await response.json();
							if (controller.signal.aborted) return;
							const answers = Object.fromEntries(
								waiting.flatMap((section) => {
									const result = results[section];
									return result?.kind === 'answer' ? [[section, Promise.resolve(result)]] : [];
								}),
							);
							if (Object.keys(answers).length) {
								recordRecovered?.();
								recovered = { initial, answers };
							}
						})
						.catch(() => {});
				},
				Math.max(0, eligibleAt - Date.now()),
			);
		}
		document.addEventListener('visibilitychange', schedule);
		const pending = Object.entries(readings).map(async ([section, answer]) => {
			try {
				return (await answer).kind === 'busy' ? [section] : [];
			} catch {
				return [];
			}
		});
		void Promise.all(pending).then((busy) => {
			waiting = busy.flat();
			// The server's original admission window has elapsed before a page makes a new read.
			eligibleAt = Date.now() + RECOVERY_DELAY_MS;
			schedule();
		});
		return () => {
			controller.abort();
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', schedule);
		};
	});

	return () => {
		const current = getRecord();
		if (!current || recovered?.initial !== current) return current;
		const { answers } = recovered;
		const extras = Object.fromEntries(
			extraReadings.flatMap((key) => (answers[key] ? [[key, answers[key]]] : [])),
		);
		return {
			...current,
			...extras,
			sections: current.sections.map((item) => {
				const answer = answers[item.section];
				return answer ? { ...item, answer } : item;
			}),
		};
	};
}
