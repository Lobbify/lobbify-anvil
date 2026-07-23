/**
 * The `resolver/` subsystem barrel — the single-pass manifest → lock resolver
 * (the `allowSource` gate before network, fail-closed conflicts, `remove` drop,
 * and constrained re-lock via `lockedPins`).
 */

export { canonicalKeyOf, pinsFromLock, resolveManifest } from "./resolve.js";
export type { ResolveManifestInput } from "./resolve.js";
