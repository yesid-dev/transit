import { alertDetailsAllowed } from '#lib/features/alerts/alertRecord.ts';
import { getRecordAnswer, type EnginePeriod, type RecordQuery } from './engine.ts';

const sections = {
	answer: {},
	day: { group: 'day' },
	hour: { group: 'hour' },
	line: { group: 'line' },
	stop: { group: 'stop_id' },
	effect: { group: 'effect' },
	cause: { group: 'cause' },
	messages: { alert_details: '1' },
} as const;

type AlertSection = keyof typeof sections;
const sectionIds = Object.keys(sections) as AlertSection[];

export function alertQuery(section: string): RecordQuery | null {
	if (!Object.hasOwn(sections, section)) return null;
	return {
		path: '/measure',
		parameters: { measure: 'alert_counts', ...sections[section as AlertSection] },
	};
}

export function loadAlertRecord(period: EnginePeriod) {
	return sectionIds
		.filter((section) => section !== 'messages' || alertDetailsAllowed(period))
		.map((section) => ({ section, answer: getRecordAnswer(alertQuery(section)!, period) }));
}
