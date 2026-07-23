/**
 * The `remote/` subsystem barrel — Stage 7 remotes: descriptors + `.anvil/config.toml`
 * remote table, the transport layer (served-tree over a dir / http / git / room),
 * content-addressed object transfer with the untrusted-lock veto, and the
 * clone / pull / push orchestration (fast-forward-only for joiners; divergence
 * stashes local commits to a `local/<ts>` branch, never discards them).
 */

export type { PathsTable, AnvilConfig } from "./config.js";
export {
  addRemote,
  listRemotes,
  readConfig,
  removeRemote,
  resolveRemote,
  serializeConfig,
  writeConfig,
} from "./config.js";
export type { RemoteDescriptor, RemoteKind } from "./descriptor.js";
export { inferRemoteKind, makeDescriptor, remoteBranch } from "./descriptor.js";
export type { GitRunner, GitTransportOptions } from "./git.js";
export { defaultGitRunner, GitTransport } from "./git.js";
export type { RoomClient, RoomTransportOptions } from "./room.js";
export { roomHttpBase, RoomTransport } from "./room.js";
export type { TreeIO } from "./tree-io.js";
export { DirTreeIO, HttpTreeIO } from "./tree-io.js";
export type {
  ContentObjectBlob,
  PublishInput,
  RemoteHead,
  RemoteTransport,
  VcObjectBlob,
} from "./transport.js";
export {
  branchRefPath,
  contentObjectPath,
  ServedTreeTransport,
  vcObjectPath,
} from "./transport.js";
export type { RemotePullAcquirerOptions } from "./transfer.js";
export { RemotePullAcquirer, validateRemoteLock } from "./transfer.js";
export type { TransportDeps } from "./factory.js";
export { makeTransport } from "./factory.js";
export type {
  CloneOutcome,
  PullOutcome,
  PushOutcome,
  RunBuild,
  SyncDeps,
} from "./sync.js";
export { cloneInstance, pullInstance, pushInstance } from "./sync.js";
