import { z } from 'zod';
import {
	StopEtaSchema as PublishedStopEtaSchema,
	TripSchema as PublishedTripSchema,
	TripsFileSchema as PublishedTripsFileSchema,
} from './generated/live_trips';
import { LiveStatusCodeSchema } from './types';

export {
	PublishedStopEtaSchema as StopEtaSchema,
	PublishedTripSchema as TripSchema,
	PublishedTripsFileSchema as TripsFileSchema,
};

const LiveStopEtaSchema = PublishedStopEtaSchema.extend({
	status: LiveStatusCodeSchema.optional(),
});
export type StopEta = z.infer<typeof LiveStopEtaSchema>;
const LiveTripSchema = PublishedTripSchema.extend({
	status: LiveStatusCodeSchema,
	stops: z.array(LiveStopEtaSchema).optional(),
	start_time: z.string().nullable().optional(),
	headsign: z.string().nullable().optional(),
	direction_id: z.number().int().nullable().optional(),
	scheduled_stops: z
		.array(
			z.object({
				stop: z.string(),
				sequence: z.number().int().nonnegative().nullable(),
				departure: z.number().int().nonnegative().nullable(),
			}),
		)
		.optional(),
	/** The timetable's first departure, for feeds that send no trip start time. */
	first_departure: z
		.object({ stop: z.string().nullable(), departure: z.number().int().nonnegative() })
		.optional(),
});
export type Trip = z.infer<typeof LiveTripSchema>;
export const LiveTripsFileSchema = PublishedTripsFileSchema.extend({
	trips: z.record(z.string(), LiveTripSchema),
});
export type TripsFile = z.infer<typeof LiveTripsFileSchema>;
