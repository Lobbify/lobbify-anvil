import { describe, expect, it } from "vitest";
import {
  Anvil,
  AnvilError,
  type AnvilEvent,
  NotImplemented,
  ProgressBus,
  RemoteNotFound,
} from "../index.js";

describe("Anvil scaffold", () => {
  it("constructs with minimal options", () => {
    const anvil = new Anvil({ dir: "/tmp/anvil-smoke" });
    expect(anvil).toBeInstanceOf(Anvil);
    expect(anvil.dir).toBe("/tmp/anvil-smoke");
  });

  it("pull with no configured remote rejects with a typed RemoteNotFound", async () => {
    const anvil = new Anvil({ dir: "/tmp/anvil-smoke-remote" });
    await expect(anvil.pull()).rejects.toBeInstanceOf(RemoteNotFound);
  });

  it("carries a stable error code + name on NotImplemented", () => {
    const err = new NotImplemented("Anvil.lock");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotImplemented");
    expect(err.code).toBe("NOT_IMPLEMENTED");
  });

  it("the Stage-7 remote/export verbs are wired (reject with typed AnvilErrors)", async () => {
    // Stage 7 lands clone/pull/push + export. Against an empty, unconfigured dir
    // they fail with typed, actionable AnvilErrors (a missing remote / manifest),
    // never a bare Error or a NotImplemented stub. (clone is exercised in the
    // remote suite with a real fixture transport — it would hit the network here.)
    const anvil = new Anvil({ dir: "/tmp/anvil-smoke-verbs" });
    const results = await Promise.allSettled([
      anvil.pull(),
      anvil.push(),
      anvil.export("pack.mrpack"),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(AnvilError);
        expect(r.reason).not.toBeInstanceOf(NotImplemented);
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
