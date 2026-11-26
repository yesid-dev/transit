type CountMap = Readonly<Record<string, number | null | undefined>>;

/**
 * Every scheduled trip in exactly one column, so a row always adds up:
 * scheduled = no live data + status unknown + ran + cancelled + missing.
 * The engine's rate ("trips that ran") divides ran by the known-status trips
 * (ran + cancelled + missing). Status unknown covers trips seen without a
 * confirmed stop and trips inside a capture gap.
 */
export type TripOutcomes = {
	scheduled: number;
	noLiveData: number;
	statusUnknown: number;
	known: number;
	ran: number;
	cancelled: number;
	missing: number;
};

export function tripOutcomes(evidence: {
	counts: CountMap;
	excluded?: CountMap | null;
}): TripOutcomes | null {
	const { scheduled, eligible, ran, cancelled, missing } = evidence.counts;
	if (scheduled == null || eligible == null || ran == null || cancelled == null || missing == null)
		return null;
	const noLiveData = evidence.excluded?.route_without_live_data ?? 0;
	const statusUnknown = scheduled - eligible - noLiveData;
	// Refuse to print a breakdown that would not add up.
	if (statusUnknown < 0 || ran + cancelled + missing !== eligible) return null;
	return { scheduled, noLiveData, statusUnknown, known: eligible, ran, cancelled, missing };
}

/** Sums daily rows; the period total must equal the sum of its days. */
export function sumTripOutcomes(rows: readonly TripOutcomes[]): TripOutcomes {
	const total: TripOutcomes = {
		scheduled: 0,
		noLiveData: 0,
		statusUnknown: 0,
		known: 0,
		ran: 0,
		cancelled: 0,
		missing: 0,
	};
	for (const row of rows)
		for (const key of Object.keys(total) as (keyof TripOutcomes)[]) total[key] += row[key];
	return total;
}
