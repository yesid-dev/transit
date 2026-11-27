export const mapControlsVisibilityContext = Symbol('map controls visibility');

export type RegisterMapControlsVisibility = (visible: () => boolean) => () => void;
