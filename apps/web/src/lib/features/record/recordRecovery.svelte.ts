import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';
import { getRecordRecovered } from './recordPatience.ts';

const RECOVERY_DELAY_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 3_000];
const RECOVERY_REQUEST_MS = 50_000;
const RECOVERY_SECTION_LIMIT = 15;
const extraReadings = ['days', 'network', 'networkDaily', 'directionalFrequency'] as const;
type Answer = Promise<EngineResult<RecordAnswer>>;
type RecordReadings = {
	sections: { section: string; answer: Answer }[];
} & Partial<Record<(typeof extraReadings)[number], Answer | null>>;
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
		const waiting = new SvelteSet<string>();
		const answers: Record<string, Answer> = {};
		let attempt = 0;
		let inFlight = false;

		function publish() {
			recovered = { initial, answers: { ...answers } };
		}

		async function read(sections: string[]) {
			const params = new SvelteURLSearchParams({
				city,
				kind,
				id,
				from,
				to,
				sections: sections.join(','),
			});
			if (direction) params.set('direction', direction);
			try {
				const signal = AbortSignal.any([
					controller.signal,
					AbortSignal.timeout(RECOVERY_REQUEST_MS),
				]);
				const response = await fetch(`/api/record-recovery?${params}`, { signal });
				if (!response.ok) return;
				const results: Record<string, EngineResult<RecordAnswer> | undefined> =
					await response.json();
				if (controller.signal.aborted) return;
				for (const section of sections) {
					const result = results[section];
					if (result?.kind !== 'answer') continue;
					waiting.delete(section);
					answers[section] = Promise.resolve(result);
				}
				if (!waiting.size) recordRecovered?.();
				publish();
			} catch {
				// The retry budget also covers transport failures and incomplete responses.
			}
		}

		function retry(section: string) {
			if (controller.signal.aborted || waiting.has(section)) return;
			if (!waiting.size) attempt = 0;
			waiting.add(section);
			answers[section] = Promise.resolve({ kind: 'busy' });
			publish();
			eligibleAt = Date.now();
			schedule();
		}

		async function recover() {
			if (document.hidden || controller.signal.aborted) return;
			inFlight = true;
			const sections = [...waiting];
			const batches = [];
			for (let index = 0; index < sections.length; index += RECOVERY_SECTION_LIMIT) {
				batches.push(read(sections.slice(index, index + RECOVERY_SECTION_LIMIT)));
			}
			await Promise.all(batches);
			inFlight = false;
			if (controller.signal.aborted || !waiting.size) return;
			const delay = RETRY_DELAYS_MS[attempt++];
			if (delay !== undefined) {
				eligibleAt = Date.now() + delay;
				schedule();
				return;
			}
			for (const section of sections) {
				if (waiting.delete(section))
					answers[section] = Promise.resolve({ kind: 'unreachable', retry: () => retry(section) });
			}
			publish();
			attempt = 0;
			eligibleAt = Date.now();
			schedule();
		}

		function schedule() {
			clearTimeout(timer);
			if (inFlight || controller.signal.aborted || document.hidden || !waiting.size) return;
			timer = setTimeout(() => void recover(), Math.max(0, eligibleAt - Date.now()));
		}
		document.addEventListener('visibilitychange', schedule);
		const pending = Object.entries(readings).map(async ([section, answer]) => {
			try {
				return [section, (await answer).kind] as const;
			} catch {
				return [section, 'unreachable'] as const;
			}
		});
		void Promise.all(pending).then((settled) => {
			if (controller.signal.aborted) return;
			let timedOut = false;
			for (const [section, kind] of settled) {
				if (kind !== 'busy' && kind !== 'timeout') continue;
				waiting.add(section);
				if (kind === 'timeout') {
					timedOut = true;
					answers[section] = Promise.resolve({ kind: 'busy' });
				}
			}
			if (timedOut) publish();
			// A deadline can be followed immediately. Admission pressure needs time to clear.
			eligibleAt = Date.now() + (timedOut ? 0 : RECOVERY_DELAY_MS);
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
