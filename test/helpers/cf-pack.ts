/**
 * A `game.from` CurseForge base-pack world: a {@link FakeCurseForge} carrying
 * real mod projects plus a *modpack* project whose file is a pack zip naming
 * those mods by `(projectID, fileID)`.
 *
 * Built to mirror the real shape rather than a convenient one. The pack zip
 * carries **no hashes and no URLs** for its members — only identity pairs — so a
 * test that passes here has exercised the actual resolution path: every member
 * fact comes from the API, and nothing comes from the pack. A fixture that
 * embedded hashes would quietly test the `.mrpack` design instead.
 */

import type { ResolvedBasePack, ResolvedRef } from "../../index.js";
import { CurseForgeBaseSource } from "../../index.js";
import { FakeCurseForge } from "./curseforge.js";
import type { FakeCfFileSpec } from "./curseforge.js";
import { fabricJar } from "./net.js";
import { makeZip } from "./zip.js";
import type { ZipEntrySpec } from "./zip.js";

export const CF_PACK_MC = "26.2";
export const CF_PACK_LOADER = "fabric 0.19.1";
/** CurseForge's class id for a modpack project. */
export const CF_CLASS_MODPACK = 4471;
/** CurseForge's class id for a mod project. */
export const CF_CLASS_MOD = 6;

/** The pack project's own id + the file id of the version under test. */
export const CF_PACK_PROJECT = 715572;

/** One member of the pack: a CurseForge project at one file id. */
export interface CfMemberSpec {
  readonly projectID: number;
  readonly fileID: number;
  readonly slug?: string;
  readonly fileName?: string;
  /** Vary the bytes so two members are genuinely distinct artifacts. */
  readonly body?: string;
  readonly classId?: number;
  /** Publish the project/file to the API but omit its attested sha1. */
  readonly noSha1?: boolean;
  /** Name it in `manifest.json` but never publish it to the API. */
  readonly unpublished?: boolean;
  /**
   * The API routes normally but answers with a body claiming a different
   * `(modId, id)` than was asked for.
   */
  readonly identitySwap?: { readonly modId?: number; readonly id?: number };
  /**
   * `GET .../files/{fileID}` throws an `HttpError` carrying this status instead
   * of answering — a 429/5xx from the file-metadata endpoint, distinct from
   * `unpublished` (a real 404: the catalogue never had this member).
   */
  readonly getFileStatus?: number;
}

export interface CfPackWorld {
  readonly http: FakeCurseForge;
  /** The `game.from` string for the pack. */
  readonly from: string;
  readonly packFileId: number;
  readonly members: readonly CfMemberSpec[];
}

export interface CfPackSpec {
  readonly members: readonly CfMemberSpec[];
  /**
   * Files published to the API but **not** listed in `manifest.json` — a newer
   * build of a base member, so an instance can pin past the base and exercise
   * the overlay's identity axis.
   */
  readonly alsoPublish?: readonly CfMemberSpec[];
  /** Loose `overrides/` files the pack ships. */
  readonly overrides?: readonly { readonly path: string; readonly data: string }[];
  /** Raw zip entries appended verbatim — zip-slip / symlink attack cases. */
  readonly malicious?: readonly ZipEntrySpec[];
  readonly packFileId?: number;
  readonly packProjectId?: number;
  readonly minecraft?: string;
  readonly loaderId?: string;
  /** Replace the whole `manifest.json` body (malformed-manifest cases). */
  readonly rawManifest?: string;
  /** Override the archive prefix `manifest.json` declares. */
  readonly overridesPrefix?: string;
  /** Omit `manifest.json` from the zip entirely. */
  readonly omitManifest?: boolean;
  /** Extra `files[]` entries injected verbatim (non-numeric ids, huge lists). */
  readonly rawFiles?: readonly unknown[];
}

function memberFileName(m: CfMemberSpec): string {
  return m.fileName ?? `${m.slug ?? `project-${m.projectID}`}-${m.fileID}.jar`;
}

/** Build the CurseForge pack zip: `manifest.json` + `overrides/`. */
export function buildCfPackZip(spec: CfPackSpec): Buffer {
  const entries: ZipEntrySpec[] = [];
  if (!spec.omitManifest) {
    const manifest =
      spec.rawManifest ??
      JSON.stringify({
        manifestType: "minecraftModpack",
        manifestVersion: 1,
        name: "Test CF Pack",
        version: "1.0.0",
        minecraft: {
          version: spec.minecraft ?? CF_PACK_MC,
          modLoaders: [{ id: spec.loaderId ?? "fabric-0.19.1", primary: true }],
        },
        // Identity pairs only — no hash, no url, no filename. This is the point.
        files: [
          ...spec.members.map((m) => ({
            projectID: m.projectID,
            fileID: m.fileID,
            required: true,
          })),
          ...(spec.rawFiles ?? []),
        ],
        ...(spec.overridesPrefix !== undefined ? { overrides: spec.overridesPrefix } : {}),
      });
    entries.push({ name: "manifest.json", data: manifest });
  }
  const prefix = spec.overridesPrefix ?? "overrides";
  for (const o of spec.overrides ?? []) {
    entries.push({ name: `${prefix}/${o.path}`, data: o.data });
  }
  entries.push(...(spec.malicious ?? []));
  return makeZip(entries);
}

/** Build the fake CurseForge world + the pack project that references it. */
export function cfPackWorld(spec: CfPackSpec): CfPackWorld {
  const http = new FakeCurseForge();
  const packProjectId = spec.packProjectId ?? CF_PACK_PROJECT;
  const packFileId = spec.packFileId ?? 8323938;

  // Publish each member as its own CurseForge project.
  const byProject = new Map<number, CfMemberSpec[]>();
  for (const m of [...spec.members, ...(spec.alsoPublish ?? [])]) {
    if (m.unpublished) {
      continue;
    }
    const list = byProject.get(m.projectID) ?? [];
    list.push(m);
    byProject.set(m.projectID, list);
  }
  for (const [projectID, list] of byProject) {
    const files: FakeCfFileSpec[] = list.map((m) => ({
      id: m.fileID,
      fileName: memberFileName(m),
      displayName: memberFileName(m),
      gameVersions: [spec.minecraft ?? CF_PACK_MC],
      bytes: fabricJar(m.body ?? `${m.projectID}-${m.fileID}`),
      ...(m.noSha1 ? { badSha1: "" } : {}),
      ...(m.identitySwap ? { lieAboutIdentity: m.identitySwap } : {}),
      ...(m.getFileStatus !== undefined ? { getFileStatus: m.getFileStatus } : {}),
    }));
    http.add({
      modId: projectID,
      slug: list[0]?.slug ?? `project-${projectID}`,
      classId: list[0]?.classId ?? CF_CLASS_MOD,
      files,
    });
  }

  // The pack itself is just another CurseForge project whose file is the zip.
  http.add({
    modId: packProjectId,
    slug: "test-cf-pack",
    classId: CF_CLASS_MODPACK,
    files: [
      {
        id: packFileId,
        fileName: `test-cf-pack-${packFileId}.zip`,
        displayName: `Test CF Pack ${packFileId}`,
        fileDate: "2026-06-10T00:00:00Z",
        gameVersions: [spec.minecraft ?? CF_PACK_MC],
        bytes: new Uint8Array(buildCfPackZip(spec)),
      },
    ],
  });

  return {
    http,
    from: `curseforge:${packProjectId}@${packFileId}`,
    packFileId,
    members: spec.members,
  };
}

/** A `resolveBase` callback wired to a CurseForge world's fake HTTP. */
export function cfBaseResolverFor(
  world: CfPackWorld,
  instanceDir: string,
  opts: {
    now: number;
    store?: ResolveBaseStore;
    allowSource?: (ref: ResolvedRef) => boolean;
    curseforgeKey?: string | null;
  },
): (ref: ResolvedRef) => Promise<ResolvedBasePack> {
  const source = new CurseForgeBaseSource();
  const key = opts.curseforgeKey === null ? undefined : (opts.curseforgeKey ?? "TEST-CF-KEY");
  return (ref) =>
    source.resolveBase(ref, {
      http: world.http,
      now: opts.now,
      allowSource: opts.allowSource ?? (() => true),
      ...(opts.store ? { store: opts.store } : {}),
      ...(key !== undefined ? { curseforgeKey: key } : {}),
      instanceDir,
    });
}

type ResolveBaseStore = NonNullable<Parameters<CurseForgeBaseSource["resolveBase"]>[1]["store"]>;
