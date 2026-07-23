/**
 * A small, dependency-free, deterministic ZIP writer for `.mrpack` export.
 *
 * The repo owns its serialization end-to-end (the lock, the TOML, the VC object
 * encoding) rather than pulling a library, for the same reason here: a `.mrpack`
 * is a distribution artifact whose bytes we want to be stable and fully under our
 * control. Entries are DEFLATE-compressed (`zlib.deflateRawSync`), CRC-32 checked,
 * UTF-8 named, and stamped with a fixed DOS timestamp, so exporting the same input
 * twice yields byte-identical output. Reads still go through `yauzl` (never
 * `unzipper`) — this module only *writes*.
 */

import { deflateRawSync } from "node:zlib";

/** One file to place in the archive (POSIX path + raw bytes). */
export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

// A fixed DOS date/time (1980-01-01 00:00:00) so output is timestamp-independent.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const UTF8_FLAG = 0x0800; // general-purpose bit 11 — filenames are UTF-8

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of a byte buffer. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface Prepared {
  readonly nameBytes: Uint8Array;
  readonly compressed: Uint8Array;
  readonly crc: number;
  readonly uncompressedSize: number;
  readonly offset: number;
}

/** Build a valid ZIP archive from entries (sorted by name for determinism). */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const localParts: Buffer[] = [];
  const prepared: Prepared[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = Buffer.from(entry.data);
    const compressed = new Uint8Array(deflateRawSync(data, { level: 9 }));
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed to extract
    header.writeUInt16LE(UTF8_FLAG, 6); // general purpose bit flag
    header.writeUInt16LE(8, 8); // compression method (deflate)
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.byteLength, 18);
    header.writeUInt32LE(data.byteLength, 22);
    header.writeUInt16LE(nameBytes.byteLength, 26);
    header.writeUInt16LE(0, 28); // extra field length
    localParts.push(header, Buffer.from(nameBytes), Buffer.from(compressed));
    prepared.push({
      nameBytes,
      compressed,
      crc,
      uncompressedSize: data.byteLength,
      offset,
    });
    offset += header.byteLength + nameBytes.byteLength + compressed.byteLength;
  }

  const centralParts: Buffer[] = [];
  let centralSize = 0;
  for (const p of prepared) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed to extract
    cd.writeUInt16LE(UTF8_FLAG, 8); // general purpose bit flag
    cd.writeUInt16LE(8, 10); // compression method
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(p.crc, 16);
    cd.writeUInt32LE(p.compressed.byteLength, 20);
    cd.writeUInt32LE(p.uncompressedSize, 24);
    cd.writeUInt16LE(p.nameBytes.byteLength, 28);
    cd.writeUInt16LE(0, 30); // extra field length
    cd.writeUInt16LE(0, 32); // file comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal file attributes
    cd.writeUInt32LE(0, 38); // external file attributes
    cd.writeUInt32LE(p.offset, 42); // relative offset of local header
    centralParts.push(cd, Buffer.from(p.nameBytes));
    centralSize += cd.byteLength + p.nameBytes.byteLength;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with the start of the central directory
  eocd.writeUInt16LE(prepared.length, 8); // entries on this disk
  eocd.writeUInt16LE(prepared.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12); // size of central directory
  eocd.writeUInt32LE(offset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, eocd]));
}
