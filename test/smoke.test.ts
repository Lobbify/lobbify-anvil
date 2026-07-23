import { describe, expect, it } from "vitest";
import { Anvil, type AnvilEvent, NotImplemented, ProgressBus } from "../index.js";

describe("Anvil scaffold", () => {
  it("constructs with minimal options", () => {
    const anvil = new Anvil({ dir: "/tmp/anvil-smoke" });
    expect(anvil).toBeInstanceOf(Anvil);
    expect(anvil.dir).toBe("/tmp/anvil-smoke");
  });

  it("throws NotImplemented from a still-stubbed async method", async () => {
    const anvil = new Anvil({ dir: "/tmp/anvil-smoke" });
    await expect(anvil.pull()).rejects.toBeInstanceOf(NotImplemented);
  });

  it("carries a stable error code + name on NotImplemented", () => {
    const err = new NotImplemented("Anvil.lock");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotImplemented");
    expect(err.code).toBe("NOT_IMPLEMENTED");
  });

  it("every not-yet-owned method is stubbed to throw NotImplemented", async () => {
    // Stage 1 implements build/verify/gc/fsck; Stage 2 adds lock; Stage 4 adds
    // init/add/remove/status/diff/why/import; Stage 5 adds the VC verbs
    // (commit/branch/switch/log/merge/rebase/revert). Only the remote verbs
    // (clone/pull/push) and export remain stubbed until Stages 6–7.
    const anvil = new Anvil({ dir: "/tmp/anvil-smoke" });
    const calls: Array<Promise<unknown>> = [
      anvil.clone("https://example.com/pack"),
      anvil.pull(),
      anvil.push(),
      anvil.export("pack.mrpack"),
    ];
    const results = await Promise.allSettled(calls);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(NotImplemented);
      }
    }
  });
});

describe("ProgressBus", () => {
  it("fans out to listeners and unsubscribes", () => {
    const bus = new ProgressBus();
    const seen: AnvilEvent[] = [];
    const off = bus.on((e) => seen.push(e));
    bus.emit({ type: "resolve:start", items: 3 });
    off();
    bus.emit({ type: "resolve:done", pinned: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("resolve:start");
  });

  it("is async-iterable and completes on close", async () => {
    const bus = new ProgressBus();
    bus.emit({ type: "build:start", stageId: "s1" });
    bus.emit({ type: "build:done", dir: "/tmp/x" });
    bus.close();
    const types: string[] = [];
    for await (const e of bus) {
      types.push(e.type);
    }
    expect(types).toEqual(["build:start", "build:done"]);
  });
});
