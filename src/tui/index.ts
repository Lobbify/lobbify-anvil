/**
 * The `tui/` subsystem barrel — the colorful, interactive TUI (Stage 8).
 *
 * The TUI is a thin skin over the {@link Anvil} library and its progress event
 * bus, exactly like the CLI: it renders library data + drives library methods,
 * and carries **no** build/merge logic. It is deliberately NOT re-exported from
 * the package's public `index.ts` so library-only consumers never pull Ink/React
 * into their graph — the CLI reaches it via a dynamic import of {@link launchTui}.
 */

export type { Capabilities, DetectOptions, StreamLike } from "./capabilities.js";
export { detectCapabilities } from "./capabilities.js";
export type { Line, Segment, SemColor } from "./segments.js";
export { plain, plainBlock, plainText, seg } from "./segments.js";
export type { InkColor } from "./theme.js";
export { inkColor } from "./theme.js";
export { kindBadge, provenanceBadge, severityBadge, sourceBadge } from "./badges.js";
export type { BumpLevel } from "./semver-diff.js";
export { bumpLevel, diffSegments, versionSegments } from "./semver-diff.js";
export type { ItemRow } from "./item-list.js";
export { buildItemRows, gameSummary, isUserItem, itemRowSegments } from "./item-list.js";
export type { ProgressState } from "./progress-model.js";
export {
  initialProgress,
  progressSegments,
  reduceAll,
  reduceProgress,
  renderBar,
} from "./progress-model.js";
export type { BlastRadius, PackContext, RelockPreview } from "./blast-radius.js";
export {
  computeBlastRadius,
  computeRelockPreview,
  packContextFromLock,
} from "./blast-radius.js";
export type { ConflictCard } from "./conflict-model.js";
export { buildConflictCards, CHOICE_HINTS, conflictCardSegments } from "./conflict-model.js";
export type { ConflictMergeResult, ResolveCard } from "./conflict-controller.js";
export { runConflictMerge } from "./conflict-controller.js";
export type { DashboardData } from "./plain.js";
export { renderPlainConflictCards, renderPlainDashboard, renderPlainProgress } from "./plain.js";
export type { EventBusLike } from "./components.js";
export {
  ColorContext,
  ColorProvider,
  ConflictCardPrompt,
  ConflictCardView,
  Dashboard,
  ItemListView,
  Lines,
  Once,
  ProgressView,
  SegmentText,
} from "./components.js";
export type { InkStreams } from "./runtime.js";
export { inkResolveCard, renderLive, renderStaticInk } from "./runtime.js";
export type { LaunchOptions } from "./launch.js";
export { launchTui } from "./launch.js";
export type { TuiAction } from "./wizard.js";
export {
  addWizard,
  chooseAction,
  confirmAction,
  initWizard,
  promptBranch,
  showNote,
  tuiIntro,
  tuiOutro,
} from "./wizard.js";
