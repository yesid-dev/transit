import { z } from 'zod';
import {
	StopEtaSchema as PublishedStopEtaSchema,
	TripSchema as PublishedTripSchema,
	TripsFileSchema as PublishedTripsFileSchema,
} from './generated/live_trips';
import { StatusCodeSchema } from './types';

export const StopEtaSchema = PublishedStopEtaSchema.extend({
	status: StatusCodeSchema.optional(),
});
export type StopEta = z.infer<typeof StopEtaSchema>;
export const TripSchema = PublishedTripSchema.extend({
	status: StatusCodeSchema,
	stops: z.array(StopEtaSchema).optional(),
});
export type Trip = z.infer<typeof TripSchema>;
export const TripsFileSchema = PublishedTripsFileSchema.extend({
	trips: z.record(z.string(), TripSchema),
});
export type TripsFile = z.infer<typeof TripsFileSchema>;
