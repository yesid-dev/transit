import type { z } from 'zod';
import {
	NetworkFileSchema as PublishedNetworkFileSchema,
	StatusDistSchema as PublishedStatusDistSchema,
} from './generated/live_network';

export { PublishedStatusDistSchema as StatusDistSchema };
const LiveStatusDistSchema = PublishedStatusDistSchema.omit({ severe: true });
export type StatusDist = z.infer<typeof LiveStatusDistSchema>;

export const NetworkFileSchema = PublishedNetworkFileSchema.extend({
	non_responding: PublishedNetworkFileSchema.shape.non_responding.nullable(),
});
export const LiveNetworkFileSchema = NetworkFileSchema.extend({
	status_dist: LiveStatusDistSchema,
});
export type NetworkFile = z.infer<typeof LiveNetworkFileSchema>;

export {
	OccupancyMixSchema,
	type OccupancyMix,
	DelayBucketSchema,
	type DelayBucket,
	NonRespondingRouteSchema,
	type NonRespondingRoute,
} from './generated/live_network';
