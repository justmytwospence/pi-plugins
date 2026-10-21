// Quiz mode for one session: whether it is on (stored in main's session, so it follows /reload,
// resume and /tree), the commit it measures changes from, the status each question carries, and the
// grades the model reports, kept in the repository's knowledge profile.
import { changedFiles, git, headCommit, quizChanges, repoRoot, signatures, type Git, type Signatures } from "./changes.ts";
import { counts, profileSummary, progressLines, ProfileStore, type Standing } from "./profile.ts";
import { quizStatus } from "./prompt.ts";
import { messageText, parseUpdates, type QuizUpdate } from "./protocol.ts";

export const QUIZ_ENTRY = "sidebar:quiz";

export interface QuizEntry {
  version: 1;
  on: boolean;
  base?: string;
  at: number;
}

type Entry = { type?: string; customType?: string; data?: unknown };

/** Quiz mode's last setting on a branch, if it was ever set. */
export function quizFromBranch(branch: readonly unknown[]): QuizEntry | undefined {
  let found: QuizEntry | undefined;
  for (const raw of branch) {
    const entry = raw as Entry;
    if (entry?.type !== "custom" || entry.customType !== QUIZ_ENTRY) continue;
    const data = entry.data as Partial<QuizEntry> | undefined;
    if (data?.version === 1 && typeof data.on === "boolean") found = { version: 1, on: data.on, ...(typeof data.base === "string" ? { base: data.base } : {}), at: Number(data.at) || 0 };
  }
  return found;
}

export interface Recorded {
  updates: QuizUpdate[];
  invalid: number;
}

export class QuizMode {
  on = false;
  base: string | undefined;
  private root: string | undefined;
  private store: ProfileStore | undefined;
  /** Signatures of the changed files when the last question went out. */
  private asked: Signatures = {};
  /** Signatures measured for the question being sent. */
  private measuring: Signatures | undefined;
  /** Signatures last nudged about, so a nudge is not repeated for the same changes. */
  private nudged: Signatures = {};
  private statusText = "";

  constructor(
    private readonly dir: string,
    private readonly run: Git = git,
    private readonly now = () => Date.now(),
  ) {}

  /** Quiz mode switched on here: measure changes from the current commit. */
  async start(cwd: string): Promise<QuizEntry> {
    await this.bindRoot(cwd);
    this.on = true;
    this.base = await headCommit(this.root!, this.run);
    this.asked = {};
    this.nudged = {};
    return { version: 1, on: true, ...(this.base ? { base: this.base } : {}), at: this.now() };
  }

  stop(): QuizEntry {
    this.on = false;
    return { version: 1, on: false, at: this.now() };
  }

  /** The setting restored from main's branch. */
  async restore(entry: QuizEntry | undefined, cwd: string): Promise<void> {
    this.on = entry?.on === true;
    this.base = entry?.on ? entry.base : undefined;
    this.statusText = "";
    if (this.on) {
      await this.bindRoot(cwd);
      // Changes already made before this restore are "since the last question": nothing asked yet here.
      this.asked = {};
      this.nudged = {};
    }
  }

  private async bindRoot(cwd: string): Promise<void> {
    const root = await repoRoot(cwd, this.run);
    if (root !== this.root || !this.store) {
      this.root = root;
      this.store = new ProfileStore(this.dir, root);
    }
  }

  /** Measure what changed and build this question's status. Call before each send while on. */
  async prepare(cwd: string, focus?: string): Promise<void> {
    if (!this.on) return;
    await this.bindRoot(cwd);
    const { changes, now } = await quizChanges(this.root!, this.base, this.asked, this.run);
    this.measuring = now;
    const profile = profileSummary(this.store!.load(), changes.files, this.now());
    this.statusText = quizStatus(changes, profile, focus);
  }

  /** The send went out: what was new is now covered. */
  sent(): void {
    if (this.measuring) {
      this.asked = this.measuring;
      this.nudged = { ...this.nudged, ...this.measuring };
    }
    this.measuring = undefined;
  }

  /** The quiz part of the live status ("" when off). */
  status(): string {
    return this.on ? this.statusText : "";
  }

  /** Grades in a turn's assistant messages, applied to the profile. */
  record(messages: readonly { role?: string; content?: unknown }[]): Recorded {
    const text = messages.filter((m) => m.role === "assistant").map((m) => messageText(m)).join("\n");
    if (!text.includes("<quiz-update>")) return { updates: [], invalid: 0 };
    const { updates, invalid } = parseUpdates(text);
    if (updates.length > 0 && this.store) {
      try { this.store.apply(updates, this.now()); } catch { return { updates: [], invalid: invalid + updates.length }; }
    }
    return { updates, invalid };
  }

  /** Files main changed since the last question that no nudge has mentioned yet. */
  async freshChanges(cwd: string): Promise<string[]> {
    if (!this.on) return [];
    await this.bindRoot(cwd);
    const files = await changedFiles(this.root!, this.base, this.run);
    const now = signatures(this.root!, files);
    const fresh = files.filter((file) => this.asked[file] !== now[file] && this.nudged[file] !== now[file]);
    this.nudged = { ...this.nudged, ...now };
    return fresh;
  }

  counts(): Record<Standing, number> | undefined {
    return this.store ? counts(this.store.load(), this.now()) : undefined;
  }

  async progress(cwd: string): Promise<string[]> {
    await this.bindRoot(cwd);
    return progressLines(this.store!.load(), this.now());
  }
}
