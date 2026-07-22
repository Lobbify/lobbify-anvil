/**
 * A tiny self-contained STORED-method zip writer for tests. No dependency (yazl
 * is not installed), and it can craft the malicious entries the zip-slip guard
 * must reject: `..` traversal, absolute paths, and symlink entries.
 */

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    const idx = (crc ^ (buf[i] as number)) & 0xff;
    crc = (CRC_TABLE[idx] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const S_IFREG = 0o100644;
const S_IFDIR = 0o040755;
const S_IFLNK = 0o120777;

export interface ZipEntrySpec {
  readonly name: string;
  /** File contents (ignored for `dir`). */
  readonly data?: string | Uint8Array;
  /** `dir` ends the name with `/`; `symlink` stores the target as the data. */
  readonly type?: "file" | "dir" | "symlink";
  /** Symlink target (for `type: "symlink"`). */
  readonly linkTarget?: string;
}

/** Build a valid STORED-method zip buffer from the given entries. */
export function makeZip(entries: readonly ZipEntrySpec[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const type = entry.type ?? "file";
    const nameBytes = Buffer.from(entry.name, "utf8");
    const fileData =
      typeof entry.data === "string"
        ? Buffer.from(entry.data, "utf8")
        : Buffer.from(entry.data ?? new Uint8Array());
    const data =
      type === "symlink"
        ? Buffer.from(entry.linkTarget ?? "", "utf8")
        : type === "dir"
          ? Buffer.alloc(0)
          : fileData;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: STORED
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(local, 30);
    localChunks.push(local, data);

    const externalAttrs =
      type === "symlink" ? S_IFLNK << 16 : type === "dir" ? (S_IFDIR << 16) | 0x10 : S_IFREG << 16;
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // version made by: unix (3) + 20
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // method STORED
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(externalAttrs >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralChunks.push(central);

    offset += local.length + data.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}
