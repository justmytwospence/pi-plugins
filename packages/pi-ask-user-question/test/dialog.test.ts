import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { split } from "../src/preview.ts";
import { dialog, KEYS, q } from "./harness.ts";

const { up, down, right, left, enter, esc, tab, shiftTab, space } = KEYS;
const type = (text: string) => [...text];
const screen = (frame: string[] | undefined) => (frame ?? []).join("\n");

const library = q("Which date library should we use?", "Library", ["date-fns", "dayjs"]);
const features = q("Which features do you want?", "Features", ["Auth", "Billing", "Search"], { multiSelect: true });

describe("single question", () => {
  test("shows the header chip, numbered options, descriptions and the Type something row", () => {
    const { frames } = dialog([library], []);
    const text = screen(frames[0]);
    expect(text).toMatch(/^ Ask user · {2}Library  ─+\n\n Which date library should we use\?/mu);
    expect(text).toMatch(/→ 1\. date-fns · date-fns description\n/u);
    expect(text).toMatch(/ {3}2\. dayjs/u);
    expect(text).toMatch(/ {3}3\. Type something\./u);
    expect(text).not.toMatch(/Review/u);
  });

  test("Enter on an option submits it", () => {
    const d = dialog([library], [down, enter]);
    expect(d.result).toEqual({
      cancelled: false,
      answers: [{ index: 0, header: "Library", question: "Which date library should we use?", kind: "option", answer: "dayjs" }],
    });
  });

  test("digits move the highlight without submitting; up and down wrap", () => {
    const d = dialog([library], ["2"]);
    expect(d.result).toBeUndefined();
    expect(screen(d.frames[1])).toMatch(/→ 2\. dayjs/u);
    const wrapped = dialog([library], [up]);
    expect(screen(wrapped.frames[1])).toMatch(/→ 3\. Type something\./u);
    expect(screen(dialog([library], ["9"]).frames[1])).toMatch(/→ 1\. date-fns/u);
  });

  test("the highlighted empty Type something row hides its label behind a cursor, still readable on screen", () => {
    const d = dialog([library], []);
    const row = (lines: string[]) => lines.find((line) => line.includes("3."))!;
    expect(row(d.dialog.render(100))).not.toContain("\x1b[8m");
    d.dialog.handleInput("3");
    const shown = row(d.dialog.render(100));
    expect(shown).toContain("\x1b[7;8mT\x1b[27mype something.\x1b[28m");
    expect(visibleWidth(shown)).toBe(visibleWidth(" → 3. Type something."));
  });

  test("j and k move outside editors and type inside them", () => {
    expect(screen(dialog([library], ["j"]).frames[1])).toMatch(/→ 2\. dayjs/u);
    const d = dialog([library], ["3", enter, "j", "k", enter]);
    expect(d.result?.answers[0]).toMatchObject({ kind: "custom", answer: "jk" });
  });

  test("Type something opens a multiline editor; Enter saves the answer", () => {
    const d = dialog([library], ["3", enter, ...type("Use"), "\x1b[13;2u", ...type("Temporal"), enter]);
    expect(d.result?.answers[0]).toMatchObject({ kind: "custom", answer: "Use\nTemporal" });
  });

  test("Esc leaves the editor and keeps the draft; Enter reopens it", () => {
    const d = dialog([library], ["3", enter, ...type("draft"), esc]);
    expect(d.result).toBeUndefined();
    expect(screen(d.frames.at(-1))).toMatch(/→ 3\. draft\s*$/mu);
    d.dialog.handleInput(enter);
    d.dialog.handleInput(enter);
    expect(d.result?.answers[0]).toMatchObject({ kind: "custom", answer: "draft" });
  });

  test.each(["n", "j", "k", "1", " ", "é", "你好", "𝛼", "\x1b[110u", "\x1b[200~pasted answer\x1b[201~"])("typing on the custom row starts an answer, not a list action: %j", (first) => {
    const d = dialog([library], ["3", first, ...type("answer"), enter]);
    const prefix = first === "\x1b[110u" ? "n" : first.startsWith("\x1b[200~") ? "pasted answer" : first;
    expect(d.result?.answers[0]).toMatchObject({ kind: "custom", answer: `${prefix}answer`.trim() });
    expect(d.result?.answers[0]?.notes).toBeUndefined();
  });

  test("an empty typed answer stays in the editor with guidance", () => {
    const d = dialog([library], ["3", enter, enter]);
    expect(d.result).toBeUndefined();
    expect(screen(d.frames.at(-1))).toContain("Write an answer before continuing.");
    d.dialog.handleInput("n");
    d.dialog.handleInput(enter);
    expect(d.result?.answers[0]).toMatchObject({ kind: "custom", answer: "n" });
  });

  test("the Type something row opens an answer field under the rows, without the editor's rules", () => {
    const d = dialog([library], ["3", ...type("i thought we wanted to")]);
    const lines = d.frames.at(-1)!;
    expect(lines.some((l) => /^ → 3\. i thought we wanted to/u.test(l))).toBe(true);
    // Pi's own input dialog layout: a title, a blank, the `›` line, a blank, the input hint.
    expect(lines.join("\n")).toMatch(/Your answer · Which date library should we use\?\s*\n\s*\n › i thought we wanted to\s*\n\s*\n enter submit {2}escape\/ctrl\+c cancel/u);
    expect(lines.join("\n")).not.toMatch(/Type something\./u);
    expect(lines.filter((l) => /^\s*─+\s*$/u.test(l))).toHaveLength(1); // only the dialog's bottom border (the top one is titled)
  });

  test("Ctrl+K on an empty field stays in it (herdr-web-ui clears a field with ctrl+k ctrl+u)", () => {
    const d = dialog([library], ["3", enter, "\x0b", "\x15", ...type("typed"), enter]);
    expect(d.result?.answers[0]).toMatchObject({ kind: "custom", answer: "typed" });
  });

  test("Ctrl+J/Ctrl+K move rows from an open field: the answer draft stays, a note is saved", () => {
    const d = dialog([library], ["3", ...type("draft"), "\n"]);
    expect(screen(d.frames.at(-1))).toMatch(/→ 1\. date-fns/u);
    expect(screen(d.frames.at(-1))).toMatch(/^ {3}3\. draft\s*$/mu);
    d.dialog.handleInput("n");
    for (const c of "small") d.dialog.handleInput(c);
    d.dialog.handleInput("\x0b");
    const text = screen(d.dialog.render(100));
    expect(text).toMatch(/→ 3\. draft/u);
    expect(text).toMatch(/note: small/u);
  });

  test("a legacy Ctrl+J (LF) in the list moves down instead of choosing", () => {
    const d = dialog([library], ["\n"]);
    expect(d.result).toBeUndefined();
    expect(screen(d.frames.at(-1))).toMatch(/→ 2\. dayjs/u);
  });

  test("ends in Pi's own key hint, as herdr-web-ui expects: rows, a blank, the hint", () => {
    const d = dialog([library], ["3", "x"]);
    expect(screen(d.frames[0])).toMatch(/ {3}3\. Type something\.\s*\n\s*\n n note {2}↑↓ navigate {2}enter select {2}escape\/ctrl\+c cancel\s*\n─+\s*$/u);
    expect(screen(d.frames.at(-1))).toMatch(/enter submit {2}escape\/ctrl\+c cancel\s*\n─+\s*$/u);
  });

  test("an empty typed answer is no answer", () => {
    const d = dialog([library], ["3", enter, enter]);
    expect(d.result).toBeUndefined();
  });

  test("n adds a note that reaches the result", () => {
    const d = dialog([library], ["n", ...type("only if small"), enter, enter]);
    expect(screen(d.frames[2])).toMatch(/Note\s*\n\s*\n › o/u);
    expect(screen(d.frames.at(-2))).toMatch(/note: only if small/u);
    expect(d.result?.answers[0]).toMatchObject({ answer: "date-fns", notes: "only if small" });
  });

  test("Ctrl+G adds a note on the custom row without stealing answer characters", () => {
    const d = dialog([library], ["3", "\x07", ...type("context"), enter, "n", ...type("one of these"), enter]);
    expect(d.result?.answers[0]).toMatchObject({ kind: "custom", answer: "none of these", notes: "context" });
  });

  test("arrows leave the highlighted custom row without opening an editor", () => {
    const d = dialog([library], ["3", up, enter]);
    expect(d.result?.answers[0]).toMatchObject({ kind: "option", answer: "dayjs" });
  });

  test("Esc cancels", () => {
    expect(dialog([library], [down, esc]).result).toEqual({ cancelled: true, answers: [] });
  });

  test("an aborted turn cancels", () => {
    const controller = new AbortController();
    const d = dialog([library], [down], { signal: controller.signal });
    controller.abort();
    expect(d.result).toEqual({ cancelled: true, answers: [] });
  });
});

describe("multi-select", () => {
  test("space toggles, Enter commits the checked options", () => {
    const d = dialog([features], [space, down, down, space]);
    expect(screen(d.frames.at(-1))).toMatch(/ {3}1\. ✓ Auth · Auth description\n {3}2\. {3}Billing · Billing description\n → 3\. ✓ Search · Search description\n {3}4\. {3}Other · type your own answer\n {3}Type your own answer: check 4, then enter\./u);
    expect(screen(d.frames[0])).toMatch(/· choose any   Submit$/mu);
    d.dialog.handleInput(enter);
    expect(d.result?.answers[0]).toMatchObject({ kind: "multi", answer: "Auth, Search", selected: ["Auth", "Search"] });
  });

  test("OmO's keys, which herdr-web-ui sends: Backspace clears, numbers toggle, Tab finishes", () => {
    const d = dialog([features], [space, "\x7f", "2", "3", "3", "1"]);
    expect(screen(d.frames[0])).toMatch(/^ Ask user · ─+\n {2}→ Features · choose any {3}Submit\n/mu);
    expect(screen(d.frames[0])).toMatch(/\n\n ↑↓ move {2}1-9 select {2}space toggle {2}enter next {2}tab done {2}n note {2}esc cancel\n─+$/u);
    expect(screen(d.frames[2])).not.toMatch(/✓/u);
    expect(d.result).toBeUndefined();
    d.dialog.handleInput(tab);
    expect(d.result?.answers[0]).toMatchObject({ kind: "multi", selected: ["Auth", "Billing"] });
  });

  test("a ticked Other asks for its text when committed, as a phone's checkbox card does it", () => {
    const d = dialog([features], ["\x7f", "1", "4", tab]);
    expect(d.result).toBeUndefined();
    expect(screen(d.frames.at(-1))).toMatch(/Your answer · Which features do you want\?\s*\n\s*\n › \s*\n\s*\n enter submit/u);
    for (const k of ["\x0b", "\x15", ...type("Payments"), enter]) d.dialog.handleInput(k);
    expect(d.result?.answers[0]).toMatchObject({ kind: "multi", selected: ["Auth", "Payments"] });
  });

  test("Enter with nothing checked picks the highlighted option", () => {
    expect(dialog([features], [down, enter]).result?.answers[0]).toMatchObject({ selected: ["Billing"] });
  });

  test("a custom answer alone needs no offered option", () => {
    const d = dialog([features], ["4", "n", ...type("one of these"), enter]);
    expect(d.result?.answers[0]).toMatchObject({ kind: "multi", selected: ["none of these"] });
  });

  test("typed text is one more selected item", () => {
    const d = dialog([features], [space, "4", enter, ...type("Admin"), enter]);
    expect(d.result?.answers[0]).toMatchObject({ kind: "multi", selected: ["Auth", "Admin"] });
  });
});

describe("several questions", () => {
  const both = [library, features];

  test("tabs, answered marks, and Review after the last answer", () => {
    const d = dialog(both, [enter]);
    expect(screen(d.frames[0])).toMatch(/→ Library {3}Features {3}Submit/u);
    expect(screen(d.frames[1])).toMatch(/Library ✓ {3}→ Features {3}Submit/u);
    expect(screen(d.frames[1])).toMatch(/Which features do you want\?/u);
    d.dialog.handleInput(down);
    d.dialog.handleInput(enter);
    const review = screen(d.dialog.render(100));
    expect(review).toMatch(/Review your answers/u);
    expect(review).toMatch(/Library → date-fns\n\s*Features → Billing/u);
    d.dialog.handleInput(enter);
    expect(d.result?.answers.map((a) => a.answer)).toEqual(["date-fns", "Billing"]);
  });

  test("Tab, Shift+Tab and the arrows cycle tabs; Review submits blanks as Unanswered", () => {
    const d = dialog(both, [tab, right, left, shiftTab, shiftTab]);
    expect(screen(d.frames[1])).toMatch(/Which features/u);
    expect(screen(d.frames[2])).toMatch(/Review your answers/u);
    expect(screen(d.frames[2])).toMatch(/Library → \(not answered\)/u);
    expect(screen(d.frames[3])).toMatch(/Which features/u);
    expect(screen(d.frames[5])).toMatch(/Review your answers/u);
    d.dialog.handleInput(enter);
    expect(d.result?.answers.map((a) => a.kind)).toEqual(["unanswered", "unanswered"]);
  });

  test.each(["custom", "notes"])("Review exposes unsaved %s and returns to it before submission", (kind) => {
    const keys = kind === "custom" ? ["3", "n"] : ["n", "n"];
    const d = dialog(both, [...keys, ...type("draft"), esc, shiftTab]);
    expect(screen(d.frames.at(-1))).toContain(`unsaved ${kind === "custom" ? "answer" : "note"}: ndraft`);
    d.dialog.handleInput(enter);
    expect(screen(d.dialog.render(100))).toMatch(kind === "custom" ? /→ 3\. ndraft/u : / › ndraft/u);
    expect(d.result).toBeUndefined();
    d.dialog.handleInput(enter);
    if (kind === "notes") d.dialog.handleInput(enter);
    d.dialog.handleInput(enter);
    d.dialog.handleInput(enter);
    expect(d.result?.answers[0]).toMatchObject(kind === "custom" ? { kind: "custom", answer: "ndraft" } : { answer: "date-fns", notes: "ndraft" });
  });

  test("Review takes a note on all the answers with n", () => {
    const d = dialog(both, [enter, enter, "n", ...type("overall"), enter]);
    const review = screen(d.frames.at(-1));
    expect(review).toMatch(/note: overall/u);
    expect(review).toMatch(/Submit these answers\?/u);
    d.dialog.handleInput(enter);
    expect(d.result).toMatchObject({ cancelled: false, note: "overall" });
  });

  test("Review returns to an unsaved review note before submission", () => {
    const d = dialog(both, [enter, enter, "n", ...type("draft"), esc]);
    expect(screen(d.frames.at(-1))).toContain("unsaved note: draft");
    d.dialog.handleInput(enter);
    expect(d.result).toBeUndefined();
    d.dialog.handleInput(enter);
    d.dialog.handleInput(enter);
    expect(d.result?.note).toBe("draft");
  });

  test("tabs do not switch while an editor is open", () => {
    const d = dialog(both, ["n", tab]);
    expect(screen(d.frames.at(-1))).toMatch(/Which date library/u);
  });

  test("Esc cancels and keeps what was answered", () => {
    const d = dialog(both, [enter, esc]);
    expect(d.result).toMatchObject({ cancelled: true, answers: [{ index: 0, answer: "date-fns" }] });
  });
});

describe("follow-ups (showIf)", () => {
  const auth = q("Which sign-in?", "Auth", ["OAuth", "API keys", "None"]);
  const provider = q("Which OAuth provider?", "Provider", ["Google", "GitHub"], { showIf: { header: "Auth", answers: ["OAuth"] } });
  const scopes = q("Which scopes?", "Scopes", ["Read", "Write"], { multiSelect: true, showIf: { header: "Provider", answers: ["GitHub"] } });
  const target = q("Deploy where?", "Target", ["Fly", "Vercel"]);
  const all = [auth, provider, scopes, target];

  test("hidden until the answer they depend on calls for them, then next in line", () => {
    const d = dialog(all, []);
    expect(screen(d.frames[0])).toMatch(/→ Auth {3}Target {3}Submit/u);
    d.dialog.handleInput(enter);
    expect(screen(d.dialog.render(100))).toMatch(/Auth ✓ {3}→ Provider {3}Target {3}Submit/u);
    d.dialog.handleInput(down);
    d.dialog.handleInput(enter);
    expect(screen(d.dialog.render(100))).toMatch(/Auth ✓ {3}Provider ✓ {3}→ Scopes {3}Target {3}Submit/u);
  });

  test("a branch not taken is skipped: no tab, no Review row, left out of the answers", () => {
    const d = dialog(all, [down, enter, enter]);
    const review = screen(d.frames.at(-1));
    expect(review).toMatch(/Auth ✓ {3}Target ✓ {3}→ Submit/u);
    expect(review).toMatch(/Auth → API keys\n\s*Target → Fly/u);
    expect(review).not.toMatch(/Provider|Scopes/u);
    d.dialog.handleInput(enter);
    expect(d.result?.answers.map((a) => [a.header, a.kind])).toEqual([["Auth", "option"], ["Provider", "skipped"], ["Scopes", "skipped"], ["Target", "option"]]);
  });

  test("changing an earlier answer hides its follow-ups again, and tabs skip hidden ones", () => {
    const d = dialog(all, [enter, down, enter, space, enter, enter]);
    expect(screen(d.frames.at(-1))).toMatch(/Review your answers/u);
    // Back to Auth, choose API keys: Provider and Scopes disappear, their answers are not reported.
    for (const key of [left, left, left, left, down, enter]) d.dialog.handleInput(key);
    expect(screen(d.dialog.render(100))).toMatch(/Auth ✓ {3}Target ✓ {3}→ Submit/u);
    d.dialog.handleInput(right);
    expect(screen(d.dialog.render(100))).toMatch(/→ Auth/u);
    d.dialog.handleInput(shiftTab);
    d.dialog.handleInput(enter);
    expect(d.result?.answers.map((a) => a.kind)).toEqual(["option", "skipped", "skipped", "option"]);
  });

  test("a typed answer opens no follow-up", () => {
    const d = dialog([auth, provider], ["4", ...type("SSO"), enter]);
    expect(screen(d.frames.at(-1))).toMatch(/Auth ✓ {3}→ Submit/u);
  });

  test("Esc leaves hidden follow-ups out even if they hold an answer", () => {
    const d = dialog(all, [enter, enter, left, left, down, enter, esc]);
    expect(d.result).toMatchObject({ cancelled: true, answers: [{ header: "Auth", answer: "API keys" }] });
    expect(d.result?.answers).toHaveLength(1);
  });
});

describe("previews", () => {
  const layouts = q("Which layout?", "Layout", ["Sidebar", "Tabs"]);
  layouts.options[0]!.preview = "```\n+------+-----+\n| side | doc |\n+------+-----+\n```";
  layouts.options[1]!.preview = "Tabs **across** the top";

  test("beside the options at 120 columns, following the highlight", () => {
    const d = dialog([layouts], [down], { columns: 120 });
    const first = d.frames[0]!;
    expect(first.some((line) => /→ 1\. Sidebar.*┌─+┐/u.test(line))).toBe(true);
    expect(first.some((line) => /│ +\| side \| doc \|/u.test(line))).toBe(true);
    expect(screen(d.frames[1])).toMatch(/│ Tabs across the top/u);
  });

  test("below the options at 80 columns", () => {
    const { frames } = dialog([layouts], [], { columns: 80 });
    const lines = frames[0]!;
    // Over the question, so the rows run straight into the key hint (herdr-web-ui reads them so).
    const top = lines.findIndex((line) => line.includes("┌"));
    const question = lines.findIndex((line) => line.includes("Which layout?"));
    expect(top).toBeLessThan(question);
    expect(lines[top]).not.toMatch(/Sidebar/u);
  });

  test("a custom answer gets the full width instead of an irrelevant preview", () => {
    const d = dialog([layouts], ["3", "n"], { columns: 120 });
    const text = screen(d.frames.at(-1));
    expect(text).toMatch(/→ 3\. n/u);
    expect(text).not.toContain("Type something.");
    expect(text).not.toContain("No preview for this option");
    expect(text).not.toContain("┌");
  });

  test("a narrow preview leaves the room to the descriptions", () => {
    const wordy = q("Which?", "Wordy", ["Mac banners", "Toasts"]);
    wordy.options[0]!.description = "A description long enough that a narrow options column would wrap it over many rows.";
    wordy.options[0]!.preview = "Current:\n\n**bold line**\nplain line";
    wordy.options[1]!.preview = "Other";
    const lines = dialog([wordy], [], { columns: 200 }).frames[0]!;
    const descRows = lines.filter((line) => /long enough|many rows/u.test(line));
    expect(descRows).toHaveLength(1);
    const top = lines.find((line) => line.includes("┌"))!;
    expect(visibleWidth(top.slice(top.indexOf("┌")))).toBeLessThanOrEqual(30);
  });

  test("a wide preview still keeps room for descriptions", () => {
    expect(split(200, { labels: 20, options: 120, preview: 300 })).toEqual({ left: 80, right: 118 });
    expect(split(200, { labels: 20, options: 40, preview: 300 })).toEqual({ left: 40, right: 158 });
    expect(split(200, { labels: 20, options: 40, preview: 10 })).toEqual({ left: 40, right: 24 });
    expect(split(100, { labels: 70, options: 90, preview: 80 })).toEqual({ left: 50, right: 48 });
  });

  test("a long preview is cut with a count", () => {
    const long = q("Which?", "Long", ["A", "B"]);
    long.options[0]!.preview = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n");
    const text = screen(dialog([long], [], { columns: 120 }).frames[0]);
    expect(text).toMatch(/… \d+ more lines/u);
    expect(text).not.toMatch(/line 39/u);
  });
});

test("no rendered line is wider than the terminal", () => {
  const wordy = q(
    "A deliberately long question that keeps going so that it has to wrap across several lines in narrow terminals?",
    "An overlong header",
    ["An option label that is far longer than five words", "Short"],
  );
  wordy.options[0]!.description = "A description that also runs on and on, explaining trade-offs in more detail than anyone needs here.";
  wordy.options[0]!.preview = `\`\`\`\n${"x".repeat(300)}\n\`\`\``;
  for (const columns of [20, 40, 80, 99, 100, 120, 200]) {
    const d = dialog([wordy, features], ["n", ...type("a note that is long enough to wrap around"), enter, enter], { columns });
    for (const keys of [[], ["3", enter, ...type("typed text")], [esc, tab, tab]]) {
      for (const key of keys) d.dialog.handleInput(key);
      for (const line of d.dialog.render(columns)) expect(visibleWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
    }
  }
});
