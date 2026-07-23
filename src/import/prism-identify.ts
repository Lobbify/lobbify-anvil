/**
 * The production {@link IdentityResolver} for Prism import — the thin network
 * wiring over the Modrinth (sha1 reverse-lookup) and CurseForge (Murmur2
 * fingerprint) identity endpoints. The Prism importer itself takes the seam, so
 * this is the only place the actual API calls live, and tests inject a fake
 * resolver instead.
 */

import type { CurseForgeApi } from "../sources/curseforge.js";
import type { ModrinthApi } from "../sources/modrinth.js";
import type { CurseForgeMatch, IdentityResolver, ModrinthMatch } from "./prism.js";

export class ApiIdentityResolver implements IdentityResolver {
  readonly #modrinth: ModrinthApi;
  readonly #curseforge?: CurseForgeApi;

  constructor(modrinth: ModrinthApi, curseforge?: CurseForgeApi) {
    this.#modrinth = modrinth;
    this.#curseforge = curseforge;
  }

  async matchModrinth(sha1: string): Promise<ModrinthMatch | undefined> {
    const version = await this.#modrinth.getVersionFile(sha1, "sha1");
    if (!version) {
      return undefined;
    }
    const file = version.files.find((f) => f.primary) ?? version.files[0];
    if (!file) {
      return undefined;
    }
    // Resolve the slug (the copy item's canonical key) from the project id.
    const project = await this.#modrinth.getProject(version.project_id);
    return { slug: project.slug, versionNumber: version.version_number, url: file.url };
  }

  async matchCurseForge(fingerprint: number): Promise<CurseForgeMatch | undefined> {
    if (!this.#curseforge) {
      return undefined;
    }
    const matches = await this.#curseforge.matchFingerprints([fingerprint]);
    const m = matches.get(fingerprint);
    if (!m) {
      return undefined;
    }
    return { projectId: m.modId, fileId: m.fileId };
  }
}
