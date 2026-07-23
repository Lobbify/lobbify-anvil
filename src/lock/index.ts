/**
 * The `lock/` subsystem barrel — the canonical, deterministic `anvil.lock`
 * schema serializer/parser and its atomic on-disk I/O. This is the byte-stable
 * spine every determinism gate compares against.
 */

export {
  LOCK_FILENAME,
  readInputLock,
  readLock,
  readLockIfPresent,
  writeInputLock,
  writeLock,
} from "./lock-io.js";
export { comparePackages, hashToString, parseLock, serializeLock } from "./serialize.js";
