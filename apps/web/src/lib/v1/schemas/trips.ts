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
});
export type Trip = z.infer<typeof LiveTripSchema>;
export const LiveTripsFileSchema = PublishedTripsFileSchema.extend({
	trips: z.record(z.string(), LiveTripSchema),
});
export type TripsFile = z.infer<typeof LiveTripsFileSchema>;
