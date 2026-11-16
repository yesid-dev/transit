/**
 * A test-owned refresh epoch. The directory wrapper keys its evidence cache to the runtime's
 * refresh epoch, so a test can bump this and observe the remount without a live refresh run.
 */
export const refreshEpoch = $state({ value: 0 });
