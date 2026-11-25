import {
	getRecordAnswer,
	query,
	type EnginePeriod,
	type RecordMeasure,
	type RecordQuery,
} from './engine.ts';
import { cityQuestion } from './engineQuestion.ts';
import { captureTripScopeSchema } from '#lib/live/captureSnapshot.ts';
import type { DepartureIdentity } from '#lib/features/record/departureIdentity.ts';
import type { Locale } from '#lib/i18n/copy.ts';
import { agencyMessageHeading } from '#lib/site/presenter.ts';
import { dailyQuestions } from './screenQuestions.ts';
export { dailyQuery, type DailySection } from './screenQuestions.ts';

const departure = {
	observed: { measure: 'late', group: 'day' },
	delay: { measure: 'punctuality' },
	stops: { measure: 'punctuality', group: 'stop' },
	missed: { measure: 'trips_run', group: 'day' },
} as const;

export type DepartureSection = keyof typeof departure;

function departureCut({ line, direction, departure }: DepartureIdentity) {
	return { line, direction: String(direction), departure };
}

export function departureQuery(section: string, identity: DepartureIdentity): RecordQuery | null {
	if (!Object.hasOwn(departure, section)) return null;
	return {
		path: '/measure',
		parameters: { ...departure[section as DepartureSection], ...departureCut(identity) },
	};
}

export function departureDay(params: URLSearchParams, { from, to }: { from: string; to: string }) {
	const day = params.get('day');
	if (!day || day < from || day > to) return to;
	const date = new Date(`${day}T00:00:00Z`);
	return Number.isFinite(+date) && date.toISOString().slice(0, 10) === day ? day : to;
}

function newestMessages(
	messages: NonNullable<RecordMeasure['evidence']['alert_messages']>,
	locale: Locale,
) {
	const natural = new Intl.Collator(locale, { numeric: true });
	return messages
		.map((message) => ({
			message,
			start: message.periods?.length
				? Math.min(...message.periods.map(({ start }) => Date.parse(start)))
				: -Infinity,
			line: message.routes[0],
			text: agencyMessageHeading(message, locale).title,
		}))
		.sort((a, b) => {
			if (a.start !== b.start) return b.start - a.start;
			if (a.line !== b.line) {
				if (a.line == null) return 1;
				if (b.line == null) return -1;
				const lineOrder = natural.compare(a.line, b.line);
				if (lineOrder) return lineOrder;
			}
			return natural.compare(a.text, b.text);
		})
		.slice(0, 5)
		.map(({ message }) => message);
}

export function loadDailyRecord(period: EnginePeriod, tracked: boolean, locale: Locale) {
	const { questions, messagesLimited } = dailyQuestions(period);
	if (messagesLimited) {
		questions.push({
			section: 'messages',
			query: { path: '/measure', parameters: { measure: 'alert_counts' } },
		});
	}
	const sections = questions
		.filter(({ section }) => tracked || section !== 'messages')
		.map(({ section, query }) => {
			const answer = getRecordAnswer(query, period);
			if (section !== 'messages') return { section, answer };
			return {
				section,
				answer: answer.then((result) => {
					if (result.kind !== 'answer' || !('value' in result.answer)) return result;
					const { evidence } = result.answer;
					if (!evidence.alert_messages?.length) return result;
					return {
						...result,
						answer: {
							...result.answer,
							evidence: {
								...evidence,
								alert_messages: newestMessages(evidence.alert_messages, locale),
							},
						},
					};
				}),
			};
		});
	return { sections, messagesLimited };
}

export function loadDepartureRecord(
	period: EnginePeriod,
	identity: DepartureIdentity,
	day: string,
) {
	return (Object.keys(departure) as DepartureSection[]).map((section) => ({
		section,
		answer: getRecordAnswer(
			departureQuery(section, identity)!,
			section === 'stops' ? { ...period, from: day, to: day } : period,
		),
	}));
}

export async function loadDepartureLive(period: EnginePeriod, identity: DepartureIdentity) {
	const result = await getRecordAnswer(
		{ path: '/measure', parameters: { measure: 'trips_run', ...departureCut(identity) } },
		period,
	);
	if (result.kind !== 'answer' || !('value' in result.answer) || result.lastGood) return [];
	return result.answer.evidence.trip_ids ?? [];
}

export async function publishedDepartureTrip(
	city: string,
	trip: string,
	identity: DepartureIdentity,
	visitorIp?: string | null,
) {
	if (!trip || trip.length > 256 || trip !== trip.trim() || /[^\S ]|\p{C}/u.test(trip)) return null;
	const question = cityQuestion(city, '/live-trips');
	question.parameters.trip = trip;
	const result = await query(question, captureTripScopeSchema, visitorIp);
	return result.kind === 'answer' &&
		result.answer.city === city &&
		result.answer.trip_updates.some(
			(row) =>
				row.trip_id === trip &&
				row.route_id === identity.line &&
				row.direction_id === identity.direction &&
				row.start_time === identity.departure,
		)
		? trip
		: null;
}
