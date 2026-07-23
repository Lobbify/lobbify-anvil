/**
 * Read-only zip/jar introspection for kind inference. Lists the central-directory
 * entry names **without extracting** anything, so it never touches disk and never
 * runs the decompressor on entry bodies. Uses `yauzl` (never `unzipper`).
 */

import { Buffer } from "node:buffer";
import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";

/** True if the bytes carry a local-file-header / end-of-central-directory zip magic. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

const MAX_NAMES = 50_000;

/** List the entry names of an in-memory zip/jar (names only, no extraction). */
export function listZipEntries(bytes: Uint8Array): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, decodeStrings: true },
      (err, zip?: ZipFile) => {
        if (err || !zip) {
          reject(err ?? new Error("not a readable zip"));
          return;
        }
        const names: string[] = [];
        zip.on("entry", (entry: Entry) => {
          names.push(entry.fileName);
          if (names.length >= MAX_NAMES) {
            zip.close();
            resolve(names);
            return;
          }
          zip.readEntry();
        });
        zip.on("end", () => resolve(names));
        zip.on("error", reject);
        zip.readEntry();
      },
    );
  });
}
