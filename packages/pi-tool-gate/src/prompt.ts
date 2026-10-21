// herdr-web-ui and Collie read this dialog off the screen for phone cards; keep its layout compatible.
// See "herdr-web-ui compatibility" and "Collie compatibility" in the repository's AGENTS.md, and run
// `npm run check:clients`, before changing rendering.
// The approval dialog. In Pi's terminal UI a held call is shown laid out and highlighted (bash one
// step per line, edits as diffs), with why it was held and the agent's case rendered as Markdown;
// long parts are clamped and ctrl+o expands them. `n` (or the "Block with a message" row) opens a
// field under the choices whose text goes to the agent with the refusal. The choices and the field
// end as Pi's own select and input dialogs do, which herdr-web-ui reads as a chat card. Elsewhere (RPC clients, forwarded subagent
// dialogs) it falls back to a plain select with a one-line summary, then a text input for a message.
import {
  DynamicBorder,
  type ExtensionContext,
  getMarkdownTheme,
  getSelectListTheme,
  highlightCode,
  type KeybindingsManager,
  keyHint,
  rawKeyHint,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Container,
  decodeKittyPrintable,
  Editor,
  type EditorTheme,
  isKeyRelease,
  Markdown,
  matchesKey,
  SelectList,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { beginComposition, type EditorCreator, editorOwnsCancel, inline, type ProseEditor } from "./editor.ts";
import type { CallView } from "./view.ts";

/** The extra row that refuses with a message; also `n` in the terminal dialog. */
export const BLOCK_WITH_MESSAGE = "Block with a message";

export interface Approval {
  view: CallView;
  /** Why the call was held, one line. */
  held?: string;
  /** The agent's case for the call, in its own words (Markdown). */
  agentCase?: string;
  /** Anything else the user should know, e.g. that Jev was unavailable. */
  note?: string;
  /** Choices, the last of which is the refusal Esc picks; "Block with a message" is added after them. */
  options: string[];
}

/** The user's answer: a choice from the options, and for a refusal with a message, the message. */
export interface ApprovalAnswer {
  choice: string;
  message?: string;
}

/** Ask the user to approve a call; resolves to the answer, or undefined if dismissed. */
export async function askApproval(
  ctx: ExtensionContext,
  approval: Approval,
  fallbackTitle: string,
  createEditor?: EditorCreator,
): Promise<ApprovalAnswer | undefined> {
  const refuse = approval.options[approval.options.length - 1] ?? "Block";
  if (ctx.mode === "tui") {
    try {
      const answer = await ctx.ui.custom<ApprovalAnswer | undefined>(
        (tui, theme, keybindings, done) => new ApprovalDialog(tui, theme, keybindings, approval, done, createEditor),
      );
      if (answer !== undefined) return answer;
    } catch {
      // Fall through to the plain dialog rather than lose the question.
    }
  }
  const choice = await ctx.ui.select(fallbackTitle, [...approval.options, BLOCK_WITH_MESSAGE]);
  if (choice === undefined) return undefined;
  if (choice !== BLOCK_WITH_MESSAGE) return { choice };
  const message = (await ctx.ui.input("Message for the agent", "why, or what to do instead"))?.trim();
  return message ? { choice: refuse, message } : { choice: refuse };
}

/** Shows the first `limit()` lines of a child, then a hint to expand. */
class Clamp implements Component {
  private readonly child: Component;
  private readonly limit: () => number | undefined;
  private readonly hint: (hidden: number) => string;
  /** Whether the last render, or any before it, left lines out. */
  clamped = false;
  constructor(child: Component, limit: () => number | undefined, hint: (hidden: number) => string) {
    this.child = child;
    this.limit = limit;
    this.hint = hint;
  }
  render(width: number): string[] {
    const lines = this.child.render(width);
    const n = this.limit();
    if (n === undefined || lines.length <= n + 1) return lines;
    this.clamped = true;
    return [...lines.slice(0, n), this.hint(lines.length - n)];
  }
  invalidate(): void {
    this.child.invalidate();
  }
}

class ApprovalDialog implements Component {
  private expanded = false;
  private readonly root = new Container();
  /** The closing border. */
  private readonly footer = new Container();
  private readonly list: SelectList;
  private readonly title = new Text("", 1, 0);
  private readonly body = new Text("", 0, 0);
  private readonly held = new Text("", 1, 0);
  private readonly caseLabel = new Text("", 1, 0);
  private readonly caseText: Component;
  private readonly note = new Text("", 1, 0);
  private readonly clamps: Clamp[] = [];
  /** The message field, shown in place of the "Block with a message" row while open. */
  private readonly message: ProseEditor;
  private editing = false;
  private emptyMessage = false;
  private hasFocus = false;
  private finished = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly a: Approval;
  private readonly refuse: string;
  private readonly done: (answer: ApprovalAnswer | undefined) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    a: Approval,
    done: (answer: ApprovalAnswer | undefined) => void,
    createEditor?: EditorCreator,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.a = a;
    this.done = done;
    this.refuse = a.options[a.options.length - 1] ?? "Block";
    const rows = [...a.options, BLOCK_WITH_MESSAGE];
    this.list = new SelectList(
      rows.map((o) => ({ value: o, label: o })),
      rows.length,
      getSelectListTheme(),
    );
    this.list.onSelect = (item) => (item.value === BLOCK_WITH_MESSAGE ? this.openMessage() : this.finish({ choice: item.value }));
    this.list.onCancel = () => this.finish({ choice: this.refuse });
    const editorTheme: EditorTheme = { borderColor: (s) => theme.fg("warning", s), selectList: getSelectListTheme() };
    const submit = (text: string) => this.submitMessage(text);
    this.message = createEditor?.(tui, editorTheme, keybindings, submit, () => this.closeMessage()) ?? (new Editor(tui, editorTheme) as ProseEditor);
    this.message.onSubmit = submit;

    const bodyRows = () => (this.expanded ? undefined : Math.max(8, Math.floor(tui.terminal.rows * 0.4)));
    const more = (hidden: number) =>
      `${theme.fg("muted", `... ${hidden} more line${hidden === 1 ? "" : "s"}, `)}${keyHint("app.tools.expand", "to expand")}`;
    this.caseText = a.agentCase ? new Markdown(a.agentCase, 1, 0, getMarkdownTheme()) : new Text("", 1, 0);

    const border = () => new DynamicBorder((s) => theme.fg("warning", s));
    const clamp = (child: Component, limit: () => number | undefined) => {
      const c = new Clamp(child, limit, more);
      this.clamps.push(c);
      return c;
    };
    const box = new Box(1, 1, (s) => theme.bg("toolPendingBg", s));
    box.addChild(clamp(this.body, bodyRows));
    this.root.addChild(border());
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.title);
    this.root.addChild(new Spacer(1));
    this.root.addChild(box);
    if (a.held) {
      this.root.addChild(new Spacer(1));
      this.root.addChild(this.held);
    }
    if (a.held !== undefined || a.agentCase !== undefined) {
      this.root.addChild(new Spacer(1));
      this.root.addChild(this.caseLabel);
      if (a.agentCase) this.root.addChild(clamp(this.caseText, () => (this.expanded ? undefined : 12)));
    }
    if (a.note) {
      this.root.addChild(new Spacer(1));
      this.root.addChild(this.note);
    }
    this.root.addChild(new Spacer(1));
    const options = new Box(1, 0);
    const selectTheme = getSelectListTheme();
    // Laid out as Pi's own select and input dialogs are (question, blank, rows, blank, key hint),
    // which is what herdr-web-ui reads a pi dialog off the screen by: a phone then gets the
    // options, or a text box for the message, instead of a bare Enter/Esc card.
    options.addChild({
      render: (width: number) => {
        const question = truncateToWidth(theme.fg("text", this.question()), Math.max(1, width));
        const out = [question, "", ...this.list.render(width), ""];
        const wrapHint = (text: string) => new Text(text, 0, 0).render(Math.max(1, width));
        if (!this.editing) {
          return [...out, ...wrapHint(`${rawKeyHint("n", "message")}  ${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`)];
        }
        // The message field opens under the rows, as Pi's own text input: a title, then `›`.
        const title = this.emptyMessage
          ? wrapHint(theme.fg("warning", "Type a message for the agent, or Esc to go back."))
          : [theme.fg("accent", theme.bold("Message for the agent"))];
        const field = inline(selectTheme.selectedPrefix("› "), "", this.message, width, theme);
        return [...out, ...title, "", ...field, "", ...wrapHint(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`)];
      },
      invalidate: () => this.list.invalidate(),
    });
    this.root.addChild(options);
    this.footer.addChild(border());
    this.paint();
  }

  /** Bake the theme's colours into the text; again on every theme change. */
  private paint(): void {
    const { theme, a } = this;
    const v = a.view;
    this.title.setText(
      [
        theme.fg("warning", theme.bold("Allow?")),
        theme.fg("toolTitle", theme.bold(v.tool)),
        v.subject ? theme.fg("accent", v.subject) : "",
        v.note ? theme.fg("muted", `(${v.note})`) : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    const body =
      v.body.kind === "diff"
        ? renderDiff(v.body.text)
        : v.body.text
          ? highlightCode(v.body.text, v.body.lang).join("\n")
          : theme.fg("muted", "(empty)");
    this.body.setText(body);
    this.held.setText(`${theme.fg("warning", theme.bold("Held: "))}${theme.fg("text", a.held ?? "")}`);
    this.caseLabel.setText(
      theme.fg("accent", theme.bold("Agent:")) + (a.agentCase ? "" : ` ${theme.fg("muted", theme.italic("(gave no reason)"))}`),
    );
    this.note.setText(theme.fg("muted", a.note ?? ""));
  }

  /** One line naming the call: the question a phone's card shows over the options. */
  private question(): string {
    const v = this.a.view;
    const command = v.tool === "bash" && v.body.kind === "code" ? v.body.text.split("\n")[0]?.trim() : "";
    const what = v.subject || command;
    return `Allow ${v.tool}${what ? ` ${what}` : ""}?`.replace(/\s+/g, " ");
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.message.focused = value && this.editing;
  }

  /** Tells key-remapping extensions (pi-select-nav) that this dialog handles its own keys. */
  [Symbol.for("pi-plugins.input-context.v1")]() {
    return this.editing ? "editor" : "list";
  }

  handleInput(data: string): void {
    if (this.finished || isKeyRelease(data)) return;
    const kb = this.keybindings;
    if (this.editing) {
      this.emptyMessage = false;
      if (kb.matches(data, "tui.select.cancel") && !editorOwnsCancel(this.message)) this.closeMessage();
      else this.message.handleInput(data);
    } else if (kb.matches(data, "app.tools.expand")) {
      this.expanded = !this.expanded;
      this.invalidate();
    } else {
      const key = data.length === 1 ? data : decodeKittyPrintable(data);
      if (key === "n") this.openMessage();
      else if (key === "j" || matchesKey(data, "ctrl+j")) this.list.handleInput("\x1b[B");
      else if (key === "k" || matchesKey(data, "ctrl+k")) this.list.handleInput("\x1b[A");
      else this.list.handleInput(data);
    }
    this.tui.requestRender();
  }

  private openMessage(): void {
    // Leave the highlight on the message row so the list shows what Enter will do.
    this.list.setSelectedIndex(this.a.options.length);
    this.editing = true;
    this.emptyMessage = false;
    beginComposition(this.message);
    this.message.focused = this.hasFocus;
    this.tui.requestRender();
  }

  private closeMessage(): void {
    this.editing = false;
    this.emptyMessage = false;
    this.message.focused = false;
    this.tui.requestRender();
  }

  private submitMessage(raw: string): void {
    const message = raw.trim();
    if (!message) {
      // An empty message keeps the field open; plain Block is one Esc away.
      this.message.setText(raw);
      this.emptyMessage = true;
      beginComposition(this.message);
      this.tui.requestRender();
      return;
    }
    this.finish({ choice: this.refuse, message });
  }

  private finish(answer: ApprovalAnswer): void {
    if (this.finished) return;
    this.finished = true;
    this.message.dispose?.();
    this.done(answer);
  }

  render(width: number): string[] {
    const body = this.root.render(width);
    return [...body, ...this.footer.render(width)];
  }

  invalidate(): void {
    this.paint();
    this.root.invalidate();
    this.footer.invalidate();
  }
}
