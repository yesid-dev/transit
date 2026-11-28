import type { Snippet } from 'svelte';
import type { SurfaceRailContext } from '@yesid/ui/layout';

export const frameSurfaceRailContext = Symbol('frame surface rail');
export type RegisterFrameSurfaceRail = (rail: Snippet<[SurfaceRailContext]>) => () => void;
