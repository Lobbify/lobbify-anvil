/**
 * Test-only fault injection.
 *
 * The store's atomic write and the build's journaled swap fire a {@link FaultHook}
 * at each crash-critical boundary. Production code never passes a hook (the hook
 * is `undefined`, so {@link fireFault} is a no-op); the crash-injection tests pass
 * one that throws at a chosen boundary to simulate a kill mid-swap, then run
 * recovery and assert the instance is left fully-old or fully-new — never partial.
 */

/** A hook fired at a named crash boundary. Throwing simulates a process kill. */
export type FaultHook = (point: string) => void | Promise<void>;

/** Fire `hook` at `point` if present; a no-op in production (no hook). */
export async function fireFault(hook: FaultHook | undefined, point: string): Promise<void> {
  if (hook) {
    await hook(point);
  }
}
