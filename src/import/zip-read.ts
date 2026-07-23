/**
 * Read a single named entry out of an in-memory zip (the `.mrpack`'s
 * `modrinth.index.json`), bounded so a malicious archive cannot exhaust memory.
 * Uses `yauzl` (never `unzipper`). Bulk untrusted extraction — the `overrides/`
 * tree — goes through the hardened {@link safeExtract} instead; this reader is
 * only for the small metadata entry.
 */

import { Buffer } from "node:buffer";
import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";
import { DecompressionBomb } from "../types/errors.js";

/** A metadata entry larger than this is treated as a decompression bomb. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Read one entry's bytes from an in-memory zip, or `undefined` if absent. */
export function readZipEntry(bytes: Uint8Array, wanted: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, decodeStrings: true },
      (err, zip?: ZipFile) => {
        if (err || !zip) {
          reject(err ?? new Error("not a readable zip"));
          return;
        }
        let done = false;
        zip.on("entry", (entry: Entry) => {
          if (done) {
            return;
          }
          if (entry.fileName !== wanted) {
            zip.readEntry();
            return;
          }
          done = true;
          zip.openReadStream(entry, (e2, stream) => {
            if (e2 || !stream) {
              reject(e2 ?? new Error(`could not read entry "${wanted}"`));
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            stream.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > MAX_ENTRY_BYTES) {
                stream.destroy();
                reject(
                  new DecompressionBomb(`zip entry "${wanted}" exceeds ${MAX_ENTRY_BYTES} bytes`),
                );
                return;
              }
              chunks.push(chunk);
            });
            stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
            stream.on("error", reject);
          });
        });
        zip.on("end", () => {
          if (!done) {
            resolve(undefined);
          }
        });
        zip.on("error", reject);
        zip.readEntry();
      },
    );
  });
}
