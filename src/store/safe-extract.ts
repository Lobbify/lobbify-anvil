/**
 * The one hardened archive extractor. Every extraction site in anvil (natives
 * jars in Stage 1; `.mrpack` / CurseForge-zip / Prism / config overrides in later
 * stages) goes through here, so the untrusted-archive defenses live in exactly
 * one place:
 *
 * - reject `..` traversal, absolute paths, and drive letters;
 * - reject symlink / non-regular entries (a symlink in the archive could redirect
 *   a later write outside the root);
 * - assert every resolved destination stays under the target root;
 * - bound the entry count and total uncompressed size (decompression-bomb guard).
 *
 * Uses `yauzl` (never `unzipper`, which eagerly pulls `@aws-sdk`).
 */

import { createWriteStream } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";
import { ensureDir } from "../internal/fs.js";
import { DecompressionBomb, PathEscape } from "../types/errors.js";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

export interface SafeExtractOptions {
  /** Return `true` to skip an entry (e.g. exclude `META-INF/` for natives). */
  readonly exclude?: (fileName: string) => boolean;
  /** Maximum entry count before the archive is treated as a bomb. */
  readonly maxEntries?: number;
  /** Maximum total uncompressed bytes before the archive is treated as a bomb. */
  readonly maxTotalBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((res, rej) => {
    // decodeStrings:false — yield raw filename buffers so *our* `assertSafeName`
    // is the sole path guard (and raises `PathEscape`), rather than yauzl's own
    // built-in rejection surfacing as an anonymous error.
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: false, decodeStrings: false },
      (err, zip) => {
        if (err || !zip) {
          rej(err ?? new Error(`could not open zip "${zipPath}"`));
        } else {
          res(zip);
        }
      },
    );
  });
}

/** Decode a (possibly raw-buffer) entry filename to a string. */
function entryName(entry: Entry): string {
  const raw = entry.fileName as unknown;
  return typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((res, rej) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        rej(err ?? new Error(`could not read entry "${entry.fileName}"`));
      } else {
        res(stream);
      }
    });
  });
}

/** The unix file-type bits an entry declares (0 when the zip carries no mode). */
function entryMode(entry: Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function assertSafeName(name: string): void {
  if (name.includes("\0")) {
    throw new PathEscape(name, "entry name contains a NUL byte");
  }
  if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:[/\\]?/.test(name)) {
    throw new PathEscape(name, "absolute or drive-letter archive entry");
  }
  const segments = name.split(/[/\\]/);
  if (segments.includes("..")) {
    throw new PathEscape(name, "archive entry traverses out of the root");
  }
}

/**
 * Extract `zipPath` under `destRoot` with every untrusted-archive guard applied.
 * Returns the relative paths written. Rejects (does not silently skip) on any
 * traversal, symlink, or bomb condition; `exclude`d entries are skipped benignly.
 */
export async function safeExtract(
  zipPath: string,
  destRoot: string,
  options: SafeExtractOptions = {},
): Promise<string[]> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const root = resolve(destRoot);
  await ensureDir(root);

  const zip = await openZip(zipPath);
  const written: string[] = [];
  let entryCount = 0;
  let totalBytes = 0;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const fail = (err: unknown) => rejectPromise(err);
      zip.on("error", fail);
      zip.on("end", () => resolvePromise());

      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const name = entryName(entry);
          entryCount += 1;
          if (entryCount > maxEntries) {
            throw new DecompressionBomb(`archive "${zipPath}" exceeds ${maxEntries} entries`);
          }

          const isDir = name.endsWith("/");
          if (!isDir && options.exclude?.(name)) {
            zip.readEntry();
            return;
          }

          assertSafeName(name);
          const abs = resolve(root, name);
          if (abs !== root && !abs.startsWith(root + sep)) {
            throw new PathEscape(name, "resolved destination escapes the extraction root");
          }

          const mode = entryMode(entry);
          if ((mode & S_IFMT) === S_IFLNK) {
            throw new PathEscape(name, "symlink archive entries are refused");
          }
          if (mode !== 0 && (mode & S_IFMT) !== S_IFREG && !isDir) {
            throw new PathEscape(name, "non-regular archive entry is refused");
          }

          if (isDir) {
            await ensureDir(abs);
            zip.readEntry();
            return;
          }

          totalBytes += entry.uncompressedSize;
          if (totalBytes > maxTotalBytes) {
            throw new DecompressionBomb(
              `archive "${zipPath}" exceeds ${maxTotalBytes} uncompressed bytes`,
            );
          }

          await ensureDir(dirname(abs));
          const stream = await openEntryStream(zip, entry);
          await pipeline(stream, createWriteStream(abs));
          written.push(name);
          zip.readEntry();
        })().catch(fail);
      });

      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  return written;
}

/** Matcher that excludes a jar's `META-INF/` tree (used for natives extraction). */
export function excludeMetaInf(fileName: string): boolean {
  return fileName === "META-INF" || fileName.startsWith("META-INF/");
}
