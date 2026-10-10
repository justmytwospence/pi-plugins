// Uniform list navigation in every pi picker, built-in or from any plugin, without forking them:
//   ctrl+j / ctrl+k  move down / up in every list, including ones with a search box or text field
//   j / k            move down / up unless you are typing into a text field
// Adding ctrl+j/ctrl+k to tui.select.down/up in keybindings.json covers components that read
// pi's keybindings. Many plugins hardcode the arrow keys instead, so this listener rewrites the
// keys into arrow keys before the focused component sees them.
//
// Left alone:
//   - the main prompt editor, or any other editor that is itself the focused component
//     (ctrl+j = newline, ctrl+k = kill line); an editor inside a dialog (such as a question's
//     "Type something" row) does not stop ctrl+j/ctrl+k from moving
//   - key releases, which kitty-protocol terminals report separately: rewriting them would move
//     twice per key
//   - j/k while a text field is being typed into: a focused Input or Editor, a component that
//     renders a text cursor (CURSOR_MARKER) or has a `focused` cursor property, or a
//     search/query/filter string, so search boxes and "Type something" rows still type letters
//   - j/k in components whose own handleInput mentions "j" or "k" (they bind those keys
//     themselves, e.g. pi-background-tasks uses k to stop a task)
//   - components listed in J_K_DENYLIST, for letter bindings the source check cannot see
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";

/** Constructor names of components where j/k must stay literal. */
const J_K_DENYLIST = new Set<string>([]);

const SKIP_FIELDS = new Set(["tui", "theme", "keybindings", "parent", "kb", "ctx", "pi", "session"]);
const SEARCH_FIELD = /search|query|filter/i;
const MAX_NODES = 400;

type Obj = Record<string, unknown>;
type Tui = { getFocusedComponent(): Obj | null; terminal?: { columns?: number } };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const isFn = (v: unknown) => typeof v === "function";
const isComponent = (v: unknown): v is Obj => isObj(v) && isFn(v.render);
const isEditor = (v: unknown): v is Obj => isObj(v) && isFn(v.getText) && isFn(v.setText);
const isInput = (v: unknown): v is Obj => isObj(v) && isFn(v.getValue) && isFn(v.setValue);

/** Breadth-first walk over a component and the components held in its fields. */
function* walk(root: Obj): Generator<Obj> {
  const seen = new Set<Obj>([root]);
  const queue: [Obj, number][] = [[root, 0]];
  while (queue.length && seen.size <= MAX_NODES) {
    const [node, depth] = queue.shift()!;
    yield node;
    if (depth >= 3) continue;
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_FIELDS.has(key)) continue;
      const items = Array.isArray(value) ? (isComponent(value[0]) ? value : []) : [value];
      for (const item of items) {
        if (!isComponent(item) && !isInput(item)) continue;
        if (seen.has(item)) continue;
        seen.add(item);
        queue.push([item, depth + 1]);
      }
    }
  }
}

/** The focused component is an editor itself: the main prompt, or a bare editor dialog. */
function isEditorRoot(root: Obj): boolean {
  return isEditor(root);
}

/**
 * Letters would type into a text field: a focused Input/Editor, a component showing a text
 * cursor (pi-tui's CURSOR_MARKER in what it renders, e.g. a question's "Type something" row), a
 * `focused` cursor property, or a search string.
 */
function isTypingText(root: Obj, width: number): boolean {
  if (isEditor(root) || isInput(root)) return true;
  if ("focused" in root) return true;
  if (showsCursor(root, width)) return true;
  for (const node of walk(root)) {
    if ((isInput(node) || isEditor(node)) && node.focused === true) return true;
    for (const [key, value] of Object.entries(node)) if (typeof value === "string" && SEARCH_FIELD.test(key)) return true;
  }
  return false;
}

function showsCursor(root: Obj, width: number): boolean {
  try {
    const lines = (root.render as (width: number) => unknown)(width);
    return Array.isArray(lines) && lines.some((line) => typeof line === "string" && line.includes(CURSOR_MARKER));
  } catch {
    return false;
  }
}

/** Does any method of the component (own or inherited) compare input against a "j"/"k" literal? */
const LETTER_LITERAL = /["'`][jk]["'`]/;
const bindsJKCache = new WeakMap<object, boolean>();
function bindsJK(component: Obj): boolean {
  for (const value of Object.values(component)) if (isFn(value) && LETTER_LITERAL.test(String(value))) return true;
  for (let proto = Object.getPrototypeOf(component); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    let hit = bindsJKCache.get(proto);
    if (hit === undefined) {
      hit = Object.getOwnPropertyNames(proto).some((name) => {
        const fn = Object.getOwnPropertyDescriptor(proto, name)?.value;
        return isFn(fn) && LETTER_LITERAL.test(String(fn));
      });
      bindsJKCache.set(proto, hit);
    }
    if (hit) return true;
  }
  return false;
}

function grabTui(ctx: ExtensionContext): Tui | undefined {
  let tui: Tui | undefined;
  ctx.ui.setWidget("select-nav-probe", (t) => {
    tui = t as unknown as Tui;
    return { render: () => [], invalidate() {} };
  });
  ctx.ui.setWidget("select-nav-probe", undefined);
  return tui;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const tui = grabTui(ctx);
    if (!tui) return;
    ctx.ui.onTerminalInput((data) => {
      // Kitty-protocol terminals also report key releases, and matchesKey ignores the event type:
      // rewriting a release into an arrow press would move twice per key.
      if (isKeyRelease(data)) return undefined;
      const control = matchesKey(data, "ctrl+j") ? DOWN : matchesKey(data, "ctrl+k") ? UP : undefined;
      const letter = matchesKey(data, "j") ? DOWN : matchesKey(data, "k") ? UP : undefined;
      if (!control && !letter) return undefined;
      const focused = tui.getFocusedComponent();
      if (!focused || isEditorRoot(focused)) return undefined;
      if (control) return { data: control };
      if (J_K_DENYLIST.has(focused.constructor?.name ?? "")) return undefined;
      if (isTypingText(focused, tui.terminal?.columns ?? 80) || bindsJK(focused)) return undefined;
      return { data: letter };
    });
  });
}
