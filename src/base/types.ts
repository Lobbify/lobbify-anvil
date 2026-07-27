/**
 * The base-pack source contract — one `game.from` reference → a fully-pinned
 * member set.
 *
 * Deliberately narrow, and deliberately *not* {@link Source}: a `Source` resolves
 * one ref to one package, while a base pack resolves one ref to a whole set plus
 * the game target that set was authored against. The two share the pinning rules
 * (frozen clock, `allowSource` before any I/O, hashes verified before they are
 * trusted) but nothing else.
 *
 * ## What an implementation owes the resolver
 *
 * - **Every member fully pinned.** A returned {@link LockPackage} is a normal
 *   lock row: the build fetches and places it through its own source, and never
 *   learns it came from a base. That is what makes base resolution a lock-time
 *   concern only — the build never re-fetches a pack.
 * - **Placement decided.** Each member's `placement` is final. Deriving it from a
 *   pack-declared path goes through `declaredPlacementTarget`, which refuses a
 *   protected top-level entry (`saves/`, `.anvil/`) rather than silently
 *   relocating it.
 * - **Identity where it exists.** A member that *is* a catalogue item should be
 *   returned as one (`source: "modrinth"` with the project slug as `name`,
 *   `source: "curseforge"` with `project`/`file`), because identity is one of the
 *   two axes the overlay overrides on. A member with no catalogue identity falls
 *   back to `url`/`local` and can then only be overridden by placement path.
 * - **Untrusted input.** A pack is attacker-controlled data. Size caps, entry
 *   caps, path safety, and hash verification are the implementation's job.
 *
 * ## Fitting CurseForge (LB-708)
 *
 * A CurseForge pack's manifest is a list of `(projectID, fileID)` pairs with no
 * hashes — a *better* diff primitive than mrpack's hashes, since it is stable
 * across re-downloads and comparable without bytes. It slots in as another
 * {@link BasePackSource} whose members carry `provenance: "replay"`,
 * `project`/`file`, and no rehostable `url`; the replay rule (CurseForge bytes
 * are fetched by the machine that needs them and never enter the shared store)
 * is a property of the member rows, so nothing here has to know about it.
 */

import type { AnvilEvent } from "../events.js";
import type {
  AllowSource,
  Hash,
  Http,
  LockPackage,
  ObjectSink,
  ResolvedRef,
  SourceKind,
} from "../types/index.js";

/** Ambient context for a base resolve. Mirrors {@link SourceContext}. */
export interface BaseResolveContext {
  /** The per-source rate-limited HTTP client. */
  readonly http?: Http;
  /** The frozen lock clock (ms). A `latest` pack spec resolves under it. */
  readonly now: number;
  /** The policy gate. Runs before **any** network I/O, for the pack and its members. */
  readonly allowSource: AllowSource;
  /** Where member bytes are admitted (copy provenance only — never replay bytes). */
  readonly store?: ObjectSink;
  /** The instance root, for a base that has to materialize loose override files. */
  readonly instanceDir: string;
  /** BYO CurseForge key. Never serialized. */
  readonly curseforgeKey?: string;
  readonly emit?: (event: AnvilEvent) => void;
}

/** One `game.from` reference, resolved to a pinned member set. */
export interface ResolvedBasePack {
  readonly source: SourceKind;
  /** The source-local pack id (slug / project id) as resolved. */
  readonly id: string;
  /** The concrete version selected under the frozen clock. */
  readonly version: string;
  /** The pack distribution's own content pin (the `.mrpack` / pack zip sha256). */
  readonly archive: Hash;
  /** The game target the pack declares — checked against the manifest's `[game]`. */
  readonly game: { readonly minecraft: string; readonly loader: string };
  /** The pack's members, each a fully-pinned lock row. */
  readonly members: readonly LockPackage[];
  /**
   * Non-fatal skips (server-only files, a member targeting `saves/`, an unusable
   * path). A pack is allowed to contain things anvil will not install; dropping
   * them silently is what is not allowed.
   */
  readonly warnings: readonly string[];
}

/** Resolves a `game.from` ref for one source kind. */
export interface BasePackSource {
  readonly kind: SourceKind;
  resolveBase(ref: ResolvedRef, ctx: BaseResolveContext): Promise<ResolvedBasePack>;
}

/** Source kind → its base-pack resolver (+ the HTTP client it fetches through). */
export type BaseRegistry = ReadonlyMap<
  SourceKind,
  { readonly source: BasePackSource; readonly http?: Http }
>;
