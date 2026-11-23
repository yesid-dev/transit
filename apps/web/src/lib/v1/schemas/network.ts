import type { z } from 'zod';
import { NetworkFileSchema as PublishedNetworkFileSchema } from './generated/live_network';

export const NetworkFileSchema = PublishedNetworkFileSchema.extend({
	non_responding: PublishedNetworkFileSchema.shape.non_responding.nullable(),
});
export type NetworkFile = z.infer<typeof NetworkFileSchema>;

export {
	StatusDistSchema,
	type StatusDist,
	OccupancyMixSchema,
	type OccupancyMix,
	DelayBucketSchema,
	type DelayBucket,
	NonRespondingRouteSchema,
	type NonRespondingRoute,
} from './generated/live_network';
