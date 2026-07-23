/**
 * CurseForge source — a Stage-2 placeholder. The real BYO-key, replay-provenance
 * implementation lands in Stage 6 (fetched per-client under the user's own key,
 * never re-hosted). Registered now so a manifest that references `curseforge:`
 * fails with a clear, typed error rather than an "unknown source".
 */

import { NotImplemented, SourceKeyMissing } from "../types/errors.js";
import type { FetchPlan, LockPackage, ResolveResult, ResolvedRef, Source } from "../types/index.js";
import type { SourceContext } from "../types/index.js";

export class CurseForgeSource implements Source {
  readonly kind = "curseforge" as const;

  async resolve(_ref: ResolvedRef, ctx: SourceContext): Promise<ResolveResult> {
    if (!ctx.curseforgeKey) {
      throw new SourceKeyMissing("curseforge");
    }
    throw new NotImplemented("CurseForge source (Stage 6)");
  }

  plan(_pkg: LockPackage, _ctx: SourceContext): FetchPlan {
    throw new NotImplemented("CurseForge fetch plan (Stage 6)");
  }
}
