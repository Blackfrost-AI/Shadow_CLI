/**
 * P3-01 — focus-owner router: shared types.
 *
 * The router replaces the old 900-line ordered `onKey` if-chain (F03-02). Instead of implicit
 * precedence derived from if-order, each frame has exactly ONE focus owner
 * (`dialog | picker | search | vim | composer`), the owner table in `router.ts` is DATA whose
 * order is pinned by a snapshot test, reserved chords (Ctrl-C / Ctrl-D exit arming, Ctrl-X
 * editor arming) resolve BEFORE owner routing, and bracketed paste is a transport ABOVE the
 * owners (the P1A-14 rule, kept).
 *
 * `KeyEnv` is the complete, compile-checked contract between the component and the key modules:
 * every ref and callback the owners read is listed here, so an extraction that forgets a ref is
 * a type error, and nothing in `src/tui/keys/` imports from `../tui.js` at runtime (type-only
 * imports aside) — no import cycles either direction.
 */
import type { ApprovalDecision, ApprovalRequest } from '../../agent/approval.js';
import type { AgentLoop } from '../../agent/loop.js';
import type { PlanModeState } from '../../agent/planMode.js';
import type { ShadowConfig, ModelEntry } from '../../config.js';
import type { ImageBlock } from '../../provider/provider.js';
import type { AutonomyLevel } from '../../safety/permissions.js';
import type { PickerRow } from '../../util/modelGroups.js';
import type { HistorySearchState } from '../composer.js';
import type { ContextName } from '../keybindings/types.js';
import type { InkKeyLike } from '../keybindings/match.js';
import type { Seat } from '../roundTable.js';
import type { VimFind, VimMode } from '../vim.js';
import type {
  ArgContext,
  QueuedTask,
  SlashCommand,
  SlashMenuItem,
  TranscriptBase,
} from '../../tui.js';

/** Ink's `useInput` callback key flags. */
export type InkKey = import('ink').Key;

/** The exactly-one-per-frame keystream owner. Precedence is the FOCUS_OWNERS table order. */
export type FocusOwner = 'dialog' | 'picker' | 'search' | 'vim' | 'composer';

/** Structural ref — avoids importing React types; all the component passes are `useRef`s. */
export interface Ref<T> {
  current: T;
}

/** A registered paste chip (Ctrl-V registry), consumed on submit. */
export interface PasteChip {
  id: number;
  content: string;
  lines: number;
}

/** One focus owner in the dispatch table. */
export interface FocusOwnerHandler {
  id: FocusOwner;
  /**
   * Whether this owner claims the keystream for this frame/key. May inspect the key for WAKE
   * chords (the search owner also claims the Ctrl-R that OPENS it, so the wake resolves at the
   * search slot's precedence — above vim — exactly as the old §2.9/§2.92 ordering required).
   */
  active: (env: KeyEnv, ch: string, key: InkKey) => boolean;
  /**
   * Handle one key. Return TRUE when the key is consumed (routing stops). Return FALSE to let
   * the key fall through to the next owner — how vim's structural keys (Enter, Tab, arrows,
   * Ctrl/Meta chords) reach the composer while NORMAL-mode motions do not.
   */
  handle: (env: KeyEnv, ch: string, key: InkKey) => boolean;
}

/**
 * Everything the key modules need from the component. Built per keystroke from stable refs +
 * useCallback actions; reads through `.current` so every owner sees live state, exactly as the
 * old inline if-chain did.
 */
export interface KeyEnv {
  // ── raw key stream ──────────────────────────────────────────────────────────
  /** The WHOLE last raw stdin chunk (DSR reports may batch with typed text). */
  rawChunkRef: Ref<string>;
  /** The LAST complete ESC-led sequence extracted from the batched chunk. */
  rawKeyRef: Ref<string>;

  // ── reserved-chord latches ─────────────────────────────────────────────────
  ctrlCArmedRef: Ref<boolean>;
  ctrlXArmedRef: Ref<boolean>;

  // ── paste transport ────────────────────────────────────────────────────────
  pastingRef: Ref<boolean>;
  pasteBufRef: Ref<string>;

  // ── dialog owner ───────────────────────────────────────────────────────────
  pendingRef: Ref<ApprovalRequest | null>;
  /** The component's InteractiveGate (implements the loop's ApprovalGate). The owners only
   *  ever RESPOND to a pending request — `request()` belongs to the loop side. */
  igateRef: Ref<{ respond: (d: ApprovalDecision) => void } | null>;
  dialogShownAtRef: Ref<number>;
  dialogTypeaheadRef: Ref<boolean>;
  autoAnswerEngagedRef: Ref<boolean>;
  autoAnswerSecsRef: Ref<number | null>;
  questionIndexRef: Ref<number>;
  questionCursorRef: Ref<Record<number, number>>;

  // ── picker owner ───────────────────────────────────────────────────────────
  pickerOpenRef: Ref<boolean>;
  pickerIndexRef: Ref<number>;

  // ── search owner ───────────────────────────────────────────────────────────
  searchRef: Ref<HistorySearchState | null>;

  // ── vim owner ──────────────────────────────────────────────────────────────
  vimEnabledRef: Ref<boolean>;
  vimModeRef: Ref<VimMode>;
  vimPendingRef: Ref<string>;
  vimCountRef: Ref<number>;
  vimFindRef: Ref<VimFind | null>;
  vimRegRef: Ref<string>;

  // ── composer owner state ───────────────────────────────────────────────────
  inputRef: Ref<string>;
  cursorRef: Ref<number>;
  historyRef: Ref<string[]>;
  histIdxRef: Ref<number>;
  draftRef: Ref<string>;
  menuIndexRef: Ref<number>;
  killRingRef: Ref<string>;
  undoRef: Ref<{ text: string; cursor: number }[]>;
  pastesRef: Ref<PasteChip[]>;
  attachmentsRef: Ref<ImageBlock[]>;
  autonomyRef: Ref<AutonomyLevel>;
  argCtxRef: Ref<ArgContext | null>;
  customCommandsRef: Ref<SlashCommand[]>;
  tableRef: Ref<{ seats: Seat[] } | null>;
  handleTableInputRef: Ref<((raw: string) => void) | null>;

  // ── session / run state ────────────────────────────────────────────────────
  runningRef: Ref<boolean>;
  controllerRef: Ref<AbortController | null>;
  loopRef: Ref<AgentLoop | null>;
  queuedTasksRef: Ref<QueuedTask[]>;
  compactingRef: Ref<boolean>;
  compactAbortRef: Ref<AbortController | null>;
  streamBufRef: Ref<string>;
  thinkBufRef: Ref<string>;
  thinkStartedAtRef: Ref<number | null>;
  pendingStreamRef: Ref<string | null>;
  pendingThinkRef: Ref<string | null>;
  answerOpenRef: Ref<boolean>;
  padCarryRef: Ref<boolean>;
  routeInFlightRef: Ref<boolean>;
  modelSwitchingRef: Ref<boolean>;
  asyncCommandRef: Ref<boolean>;

  // ── config ─────────────────────────────────────────────────────────────────
  cfg: ShadowConfig;
  planMode?: PlanModeState;
  /** SHADOW_NO_AUTO_ANSWER !== '1' (module-load constant in tui.tsx). */
  autoAnswerEnabled: boolean;
  /** Live composer inner width (cols − gutter − page margins), matching Composer paint. */
  composerInnerWidth: () => number;

  // ── actions (component callbacks) ──────────────────────────────────────────
  exit: () => void;
  pushLine: (l: Omit<TranscriptBase, 'id' | 'kind'> & { kind?: TranscriptBase['kind'] }) => void;
  setQueued: (next: QueuedTask[]) => void;
  setLine: (v: string) => void;
  setComposer: (nextInput: string, nextCursor: number) => void;
  setCursor: (n: number) => void;
  setMenuIndex: (n: number) => void;
  setPickerOpen: (b: boolean) => void;
  setPickerIndex: (n: number) => void;
  setVimMode: (m: VimMode) => void;
  setQuestionCursor: (idx: number, pos: number) => void;
  setQuestionIndex: (n: number) => void;
  setAutoAnswerSecs: (n: number | null) => void;
  setAutonomy: (l: AutonomyLevel) => void;
  insertPastable: (t: string) => void;
  /** Apply a live-slot value immediately AND drop any pending coalesced flush. */
  setStreamNow: (v: string) => void;
  setThinkNow: (v: string) => void;
  applyEdit: (r: { text: string; cursor: number; killed: string }) => void;
  moveCaret: (n: number) => void;
  pushUndo: () => void;
  handleMouse: (ch: string) => void;
  openExternalEditor: () => void;
  applySearch: (st: HistorySearchState | null) => void;
  kbConsume: (input: string, key: InkKeyLike, contexts: readonly ContextName[]) => boolean;
  chooseAtQuestion: (idx: number, pos: number) => void;
  confirmQuestion: () => void;
  selectModel: (entry: ModelEntry) => void;
  runSlash: (cmd: SlashCommand, rawLine?: string) => void;
  startTurn: (task: string) => void;
  ensureFileList: () => string[];
  slashMatches: (
    input: string,
    current: Record<string, string | undefined> | undefined,
    ctx: ArgContext | undefined,
    extra: SlashCommand[],
  ) => SlashMenuItem[];
  findSlashCommand: (name: string, extra?: SlashCommand[]) => SlashCommand | undefined;
  classifySlash: (
    task: string,
    extra?: SlashCommand[],
  ) => { cmd?: SlashCommand; kind: 'command' | 'typo' | 'message'; suggestion?: string };
  slashDispatchName: (cmd: SlashCommand) => string;
  modelRows: (cfg: ShadowConfig) => PickerRow[];
  sanitizeAssistantText: (t: string) => string;
}
