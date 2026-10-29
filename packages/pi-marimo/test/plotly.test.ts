import { expect, test } from "vitest";
import { summarizeOutput } from "../src/core/output.js";
import { PlotlyDaemon } from "../src/core/plotly.js";

// A stand-in for the Python process: says ready, then answers each request line.
const FAKE = `
console.log(JSON.stringify({ready:true}));
let buf="";
process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const r = JSON.parse(buf.slice(0,i)); buf = buf.slice(i+1);
  console.log(JSON.stringify(r.fig.fail ? {id:r.id,error:"bad figure"} : {id:r.id,png:Buffer.from(String(r.fig.data.length)).toString("base64")})); } });
`;
const fake = (extra: ConstructorParameters<typeof PlotlyDaemon>[0] = {}) => new PlotlyDaemon({ command: ["node", "-e", FAKE], ...extra });

test("requests go to one warm process and come back by id", async () => {
  const d = fake();
  try {
    const [a, b] = await Promise.all([d.render('{"data":[1,2],"layout":{}}'), d.render('{"data":[1],"layout":{}}')]);
    expect(Buffer.from(a, "base64").toString()).toBe("2");
    expect(Buffer.from(b, "base64").toString()).toBe("1");
  } finally { d.stop(); }
});

test("a figure the renderer rejects fails that request only", async () => {
  const d = fake();
  try {
    await expect(d.render('{"fail":true}')).rejects.toThrow("bad figure");
    await expect(d.render('{"data":[],"layout":{}}')).resolves.toBeTypeOf("string");
    await expect(d.render("not json")).rejects.toThrow("not a plotly figure");
  } finally { d.stop(); }
});

test("a process that dies fails what was waiting, and the next request starts a new one", async () => {
  const d = new PlotlyDaemon({ command: ["node", "-e", "process.stderr.write('no browser\\n'); process.exit(3)"] });
  await expect(d.render('{"data":[]}')).rejects.toThrow("no browser");
  await expect(d.render('{"data":[]}')).rejects.toThrow("no browser");
});

test("a daemon that idles ends its process", async () => {
  const d = fake({ idleMs: 30 });
  await d.render('{"data":[],"layout":{}}');
  await new Promise((r) => setTimeout(r, 80));
  // Stopped: the next request starts it again and still works.
  await expect(d.render('{"data":[1],"layout":{}}')).resolves.toBeTypeOf("string");
  d.stop();
});

test("marimo's two Plotly outputs keep their figure: mo.ui.plotly and a figure's own iframe page", () => {
  const fig = { data: [{ x: [1, 2], y: [3, 4], type: "scatter" }], layout: { title: { text: "a } [ b" } } };
  const attr = JSON.stringify(fig).replace(/"/gu, "&quot;");
  expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: `<marimo-ui-element><marimo-plotly data-figure='${attr}'></marimo-plotly></marimo-ui-element>` })).toMatchObject({ kind: "chart", plotly: JSON.stringify(fig) });
  const page = `<div id="x"><script>Plotly.newPlot("id-1", ${JSON.stringify(fig.data)}, ${JSON.stringify(fig.layout)}, {"responsive": true})</script></div>`;
  const srcdoc = page.replace(/&/gu, "&amp;").replace(/'/gu, "&#x27;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
  expect(JSON.parse(summarizeOutput({ channel: "output", mimetype: "text/html", data: `<iframe srcdoc='${srcdoc}'></iframe>` })!.plotly!)).toEqual(fig);
});
