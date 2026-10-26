import { expect, test } from "vitest";
import { footerRows } from "../src/footer.ts";

for (const width of [46, 120]) {
  test(`measures native/custom footers at ${width} columns in both renderers`, () => {
    let height = 3;
    const footer = { render: (w: number) => { expect(w).toBe(width); return Array(height).fill("footer"); } };
    const tui = { terminal: { columns: width }, children: [footer] };
    expect(footerRows(tui as any)).toBe(3);
    const viewport = { entries: [{ component: { scrollTo() {}, primary: true } }, { component: { entries: [{ component: {} }, { component: footer }] } }] };
    const fullscreen = { ...tui, layoutRoot: { entries: [{ component: viewport }] } };
    expect(footerRows(fullscreen as any)).toBe(3);
    height = 7;
    expect(footerRows(fullscreen as any)).toBe(7);
  });
}

test("unknown, cyclic and throwing layouts do not break the terminal", () => {
  const root: any = { children: [] }; root.children.push(root);
  expect(footerRows({ layoutRoot: root } as any)).toBe(0);
  expect(footerRows({ terminal: { columns: 80 }, children: [{ render() { throw Error("disposed"); } }] } as any)).toBe(0);
});
