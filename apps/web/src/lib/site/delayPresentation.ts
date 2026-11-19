export type DelayTone = 'none' | 'early' | 'on-time' | 'late' | 'severe';

export function delayTone(delay: number | null | undefined): DelayTone {
	if (delay == null) return 'none';
	if (delay < 0) return 'early';
	if (delay >= 5) return 'severe';
	if (delay > 0) return 'late';
	return 'on-time';
}

export function delayMeasurement(delay: number | null | undefined): string | null {
	if (delay == null) return null;
	return `${delay < 0 ? '−' : delay > 0 ? '+' : ''}${Math.abs(delay)} min`;
}

export interface DelayLabelCopy {
	readonly early: (minutes: number) => string;
	readonly late: (minutes: number) => string;
	readonly onTime: string;
	readonly noDelay?: string;
}

export function delayLabel(delay: number | null | undefined, copy: DelayLabelCopy): string {
	if (delay == null) return copy.noDelay ?? copy.onTime;
	if (delay < 0) return copy.early(delay);
	if (delay > 0) return copy.late(delay);
	return copy.onTime;
}
