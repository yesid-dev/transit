import { serviceClockParts } from '#lib/utils/serviceDate.ts';

/** The Live departure lookup uses the provider's current service date. */
export function isBeforeTodaysDeparture(start: string, timeZone: string, now = new Date()) {
	const scheduled = serviceClockParts(start);
	if (!scheduled) return false;

	const local = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		hourCycle: 'h23',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(now);
	const part = (type: 'hour' | 'minute' | 'second') =>
		Number(local.find((entry) => entry.type === type)?.value);
	return (
		part('hour') * 3600 + part('minute') * 60 + part('second') <
		scheduled.hours * 3600 + scheduled.minutes * 60 + Number(start.split(':')[2] ?? 0)
	);
}
