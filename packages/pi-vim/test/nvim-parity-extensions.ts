/**
 * Neovim parity for the commands pi-vim adds on top of the upstream engine:
 * stock Vim motions, objects and operators it lacked, and the targets.vim,
 * surround.vim and vim-wordmotion behaviour, checked against Neovim with
 * those plugins loaded from ~/.vim/plugins (or PI_VIM_PLUGIN_DIR). Plugin
 * cases are skipped when the plugin is not installed.
 */
import { describe, it } from "node:test";
import {
  assertMatchesNvim,
  type NvimParityCase,
  type NvimParityPlugin,
  pluginsAvailable,
} from "./nvim-oracle.js";

const ESC = "\x1b";
const keys = (s: string): string[] => Array.from(s);

function c(
  name: string,
  text: string,
  cursor: [number, number],
  typed: string,
  extra: { plugins?: NvimParityPlugin[]; setup?: string[]; register?: string } = {},
): NvimParityCase {
  return {
    name,
    initial: { text, cursor: { line: cursor[0], col: cursor[1] }, register: extra.register },
    keys: keys(typed),
    plugins: extra.plugins,
    setup: extra.setup,
  };
}

const SW = ["set sw=2 et"];
const PROSE = "Hello there. This is a test!  Another one?\nNext line here. And more.\n\nNew para. End.";
const PARAS = "one\ntwo\n\nthree\nfour\n\n\nfive";

const STOCK: NvimParityCase[] = [
  // motions
  c("ge to the end of the previous word", "foo bar.baz qux", [0, 9], "ge"),
  c("3gE back three WORD ends", "foo bar.baz qux zap", [0, 17], "3gE"),
  c("dge deletes back through the previous word end", "foo bar baz", [0, 8], "dge"),
  c(") to the next sentence", PROSE, [0, 2], ")"),
  c("2( back two sentences", PROSE, [1, 18], "2("),
  c("d) deletes to the next sentence", PROSE, [0, 13], "d)"),
  c("c( changes back to the sentence start", PROSE, [0, 20], `c(X${ESC}`),
  c("+ to the next line's first non-blank", "a\n  b\nc", [0, 0], "+"),
  c("- to the previous line's first non-blank", "  a\nb\nc", [2, 0], "-"),
  c("d+ deletes two lines", "a\nb\nc", [0, 0], "d+"),
  c("4| to column 4", "abcdefgh", [0, 0], "4|"),
  c("d| deletes back to column 1", "abcdefgh", [0, 5], "d|"),
  c("g_ to the last non-blank", "abc   ", [0, 0], "g_"),
  c("d} deletes to the paragraph end", PARAS, [0, 1], "d}"),
  c("dgg deletes to the first line", "a\nb\nc", [2, 0], "dgg"),
  c("* finds the next whole word", "foo foobar foo bar", [0, 0], "*"),
  c("# finds the previous whole word", "foo bar foo baz foo", [0, 17], "#"),
  c("*n wraps to the next match", "ab x ab y ab", [0, 0], "*n"),
  c("*N goes back", "ab x ab y ab", [0, 0], "*N"),
  c("g* matches inside words", "foo foobar", [0, 0], "g*"),
  // case and other operators
  c("~ toggles case and advances", "hello", [0, 0], "~~"),
  c("3~ toggles three", "hello", [0, 1], "3~"),
  c("~ at the end of the line", "ab", [0, 1], "~"),
  c("gUiw uppercases a word", "foo bar", [0, 5], "gUiw"),
  c("guu lowercases the line", "  FOO Bar", [0, 4], "guu"),
  c("gUgU uppercases the line", "foo bar", [0, 4], "gUgU"),
  c("g~w swaps case", "Foo bar", [0, 0], "g~w"),
  c("g~~ swaps the line", "Foo Bar", [0, 2], "g~~"),
  c("g?? rot13 the line", "Hello", [0, 0], "g??"),
  c("gUe uppercases to the word end", "foo bar", [0, 1], "gUe"),
  c("gU$ uppercases to the end", "foo bar", [0, 2], "gU$"),
  c("gUtx uppercases till x", "abcxdef", [0, 0], "gUtx"),
  c("gUj uppercases two lines", "ab\ncd\nef", [0, 1], "gUj"),
  c(". repeats gUiw", "foo bar", [0, 0], "gUiww."),
  c(">> shifts the line", "foo\nbar", [0, 0], ">>", { setup: SW }),
  c("3>> shifts three lines", "a\nb\nc\nd", [0, 0], "3>>", { setup: SW }),
  c("<< unshifts", "    foo", [0, 5], "<<", { setup: SW }),
  c(">j shifts two lines", "a\n\nb", [0, 0], ">j", { setup: SW }),
  c(">ip shifts a paragraph", "a\nb\n\nc", [0, 0], ">ip", { setup: SW }),
  c(">>. shifts twice", "a", [0, 0], ">>.", { setup: SW }),
  c("CTRL-A increments", "x 5 y", [0, 0], "\x01"),
  c("5 CTRL-X decrements", "val -3 end", [0, 0], "5\x18"),
  c("CTRL-A on hex", "0xff", [0, 0], "\x01"),
  c("CTRL-A then dot", "1", [0, 0], "\x01."),
  // Replace mode
  c("R overwrites", "abcdef", [0, 1], `RXY${ESC}`),
  c("R past the end appends", "ab", [0, 1], `RXYZ${ESC}`),
  c("R then dot", "abcdef ghij", [0, 0], `RXY${ESC}w.`),
  // registers
  c('"_dd keeps the register', "a\nb", [0, 0], '"_dd', { register: "keep" }),
  c('"_d then p puts the old register', "abc", [0, 0], '"_dlp', { register: "Z" }),
  c('"ayw yanks into the unnamed register', "foo bar", [0, 0], '"ayw'),
  // gv and gi
  c("gv reselects", "hello world", [0, 0], `vll${ESC}wgvd`),
  c("gi inserts where insert stopped", "hello world", [0, 0], `eaX${ESC}0giY${ESC}`),
  // objects
  c("dip on a paragraph", PARAS, [1, 0], "dip"),
  c("dap on a paragraph", PARAS, [0, 1], "dap"),
  c("d2ap", PARAS, [0, 0], "d2ap"),
  c("dis deletes a sentence", PROSE, [0, 15], "dis"),
  c("das deletes a sentence and blanks", PROSE, [0, 15], "das"),
  c("cis changes a sentence", PROSE, [1, 3], `cisX${ESC}`),
  c("dit deletes inside a tag", "x <b>y z</b> w", [0, 6], "dit"),
  c("dat deletes a tag block", "x <b>y z</b> w", [0, 6], "dat"),
  c("d2it on nested tags", "<a><b>x</b></a>", [0, 7], "d2it"),
  c("di< deletes inside angle brackets", "a <b c> d", [0, 4], "di<"),
  c("di( seeks the next block", "foo (bar) baz", [0, 0], "di("),
  c("ci\" seeks the next quote", 'say "hi there" ok', [0, 0], `ci"X${ESC}`),
  c("gUip uppercases a paragraph", "ab\ncd\n\nef", [0, 0], "gUip"),
  // Visual mode
  c("vip selects a paragraph", PARAS, [0, 0], "vipd"),
  c("vis selects a sentence", PROSE, [0, 15], "visd"),
  c("viw then ~", "foo bar", [0, 5], "viw~"),
  c("vU uppercases", "foo bar", [0, 1], "vllU"),
  c("Vu lowercases lines", "FOO\nBAR", [0, 0], "Vju"),
  c("v> shifts", "a\nb", [0, 0], "vj>", { setup: SW }),
  c("V3> shifts three times", "a\nb", [0, 0], "V3>", { setup: SW }),
  c("v< unshifts", "    a", [0, 4], "v<", { setup: SW }),
  c("vJ joins", "a\nb\nc", [0, 0], "vjJ"),
  c("VgJ joins without spaces", "a\n b\nc", [0, 0], "VjgJ"),
  c("vr replaces", "abcdef", [0, 1], "vllrx"),
  c("vP replaces the selection", "hello world", [0, 6], "veP", { register: "there" }),
  c("viwP keeps the register for the next paste", "foo bar", [0, 0], "viwPwviwP", { register: "X" }),
  c("vP with a linewise register", "abc def", [0, 4], "vlP", { register: "L1\n" }),
  c("VP replaces lines", "a\nb\nc", [1, 0], "VP", { register: "X\n" }),
];

const TARGETS: NvimParityCase[] = [
  ["ci( seeks forward", "foo (bar) baz", [0, 0], `ci(X${ESC}`],
  ["din( next pair", "a (b) c (d) e", [0, 3], "din("],
  ["dI( trims blanks", "f( x )", [0, 3], "dI("],
  ["dA( takes trailing blank", "a (x) b", [0, 3], "dA("],
  ["d2i( grows", "a ( b ( c ) d ) e", [0, 8], "d2i("],
  ["di( multi-line block", "if (\n  x,\n  y\n) z", [1, 2], "di("],
  ["dib any block", "a [b (c) d] e", [0, 6], "dib"],
  ["ci\" between quotes", 'join("hello", "world")', [0, 12], `ci"X${ESC}`],
  ["da\" no trailing blank", 'say "hi" now', [0, 5], 'da"'],
  ["dA\" takes a blank", 'say "hi" now', [0, 5], 'dA"'],
  ["din\" next quote", "a 'b' c 'd' e", [0, 3], "din'"],
  ["diq any quote", "x 'a' y", [0, 3], "diq"],
  ["da, list item", "Shopping list: oranges, apples, bananas, tomatoes", [0, 27], "da,"],
  ["di, between commas", "a, b, c", [0, 3], "di,"],
  ["dI_ inner separator", "x_ab_y", [0, 3], "dI_"],
  ["dia argument", "f(a, bb, c)", [0, 6], "dia"],
  ["daa first argument", "f(a, bb, c)", [0, 2], "daa"],
  ["daa last argument", "f(a, bb, c)", [0, 9], "daa"],
  ["cia nested", "f(a, g(b, c), d)", [0, 10], `ciaX${ESC}`],
  ["dit tag", "x <b>y z</b> w", [0, 6], "dit"],
  ["dint next tag", "<a>x</a> <b>y</b>", [0, 1], "dint"],
  ["ci( on empty pair", "f()", [0, 0], `ci(X${ESC}`],
  ["vi( selects", "a (bcd) e", [0, 4], "vi(d"],
  ["va\" selects", 'a "bc" d', [0, 0], 'va"d'],
  ["yi( yanks", "a (bcd) e", [0, 4], "yi(P"],
  ["gUi( uppercases", "a (bcd) e", [0, 4], "gUi("],
].map(([name, text, cursor, typed]) =>
  c(`targets ${name}`, text as string, cursor as [number, number], typed as string, { plugins: ["targets"] }),
);

const SURROUND: NvimParityCase[] = [
  ["ysiw)", "Hello world!", [0, 7], "ysiw)"],
  ["ysiw(", "Hello world!", [0, 7], "ysiw("],
  ["ysw] keeps the blank outside", "foo bar", [0, 0], "ysw]"],
  ["ys$\"", "say hi there", [0, 4], 'ys$"'],
  ["ysiwt", "foo bar", [0, 4], "ysiwtem>"],
  ["ysiwt with Enter", "foo bar", [0, 4], "ysiwtdiv class=\"x\"\r"],
  ["ysiwf", "foo bar", [0, 4], "ysiwfprint\r"],
  ["yssB", "    Hello world!", [0, 6], "yssB"],
  ["yss)", "  abc  ", [0, 3], "yss)"],
  ["ySS{", "  foo", [0, 2], "ySS{"],
  ["ysip on lines", "a\nb\n\nc", [0, 0], "ysip)"],
  ["ys2w*", "one two three", [0, 0], "ys2w*"],
  ["ysiw) then dot", "foo bar", [0, 0], "ysiw)ww."],
  ["ds\"", '"Hello world!"', [0, 8], 'ds"'],
  ["ds)", "(123+456)/2", [0, 5], "ds)"],
  ["ds( trims", "( 123 )/2", [0, 3], "ds("],
  ["dst", "<div>Yo!</div>", [0, 7], "dst"],
  ["ds* punctuation", "say *bold* now", [0, 6], "ds*"],
  ["ds\" seeks forward", 'say "hi" now', [0, 0], 'ds"'],
  ["ds( then dot", "((a))", [0, 2], "ds(."],
  ["cs\"'", '"Hello world!"', [0, 8], "cs\"'"],
  ["cs\"<q>", '"Hello world!"', [0, 8], 'cs"<q>'],
  ["cs)]", "(123+456)/2", [0, 5], "cs)]"],
  ["cs)[", "(123+456)/2", [0, 5], "cs)["],
  ["cst<p>", "<div>Yo!</div>", [0, 7], "cst<p>"],
  ["csrb", "a [b] c", [0, 3], "csrb"],
  ["ds{ multi-line", "if (x) {\n  foo();\n}", [1, 3], "ds{"],
  ["cs) then dot", "(a) (b)", [0, 1], "cs)]f(."],
  ["vS'", "my $str = whee!;", [0, 10], "vllllS'"],
  ["vS)", "foo bar", [0, 4], "veS)"],
  ["VS{", "  foo\n  bar", [0, 2], "VjS{"],
  ["VSt", "foo", [0, 0], "VStp>"],
].map(([name, text, cursor, typed]) =>
  c(`surround ${name}`, text as string, cursor as [number, number], typed as string, {
    plugins: ["surround"],
    setup: SW,
  }),
);

const WM = "CamelCaseACRONYMWords_underscore1234 foo-bar";
const WORDMOTION: NvimParityCase[] = [
  ["w", WM, [0, 0], "w"],
  ["3w", WM, [0, 0], "3w"],
  ["e", WM, [0, 0], "e"],
  ["b", WM, [0, 20], "b"],
  ["ge", WM, [0, 20], "ge"],
  ["dw", WM, [0, 0], "dw"],
  ["cw", WM, [0, 0], `cwX${ESC}`],
  ["de", WM, [0, 5], "de"],
  ["diw", WM, [0, 11], "diw"],
  ["daw at underscore", WM, [0, 21], "daw"],
  ["ciw", "getHTTPResponse()", [0, 5], `ciwX${ESC}`],
  ["d2aw at the end", WM, [0, 40], "d2aw"],
  ["dw at line end", "foo bar\n  baz", [0, 4], "dw"],
  ["yiwP", "fooBar baz", [0, 4], "yiwP"],
  ["gUiw", "fooBar baz", [0, 4], "gUiw"],
  ["w across lines", "fooBar\n\nbaz", [0, 3], "ww"],
  ["viw", "fooBarBaz", [0, 4], "viwd"],
].map(([name, text, cursor, typed]) =>
  c(`wordmotion ${name}`, text as string, cursor as [number, number], typed as string, {
    plugins: ["wordmotion"],
  }),
);

function suite(title: string, cases: NvimParityCase[]): void {
  describe(title, () => {
    for (const testCase of cases) {
      it(testCase.name, { skip: !pluginsAvailable(testCase.plugins) }, async () => {
        await assertMatchesNvim(testCase);
      });
    }
  });
}

suite("nvim parity: stock commands added to pi-vim", STOCK);
suite("nvim parity: targets.vim", TARGETS);
suite("nvim parity: surround.vim", SURROUND);
suite("nvim parity: vim-wordmotion", WORDMOTION);
