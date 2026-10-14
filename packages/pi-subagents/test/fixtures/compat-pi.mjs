// A deterministic RPC child using the actual web-access storage, Pi auth reader and auto-effort
// sibling. It never loads web search/fetch, starts a server, or calls a classifier/provider.
import readline from "node:readline";
import path from "node:path";
import { createJiti } from "jiti";
import { stateResponse } from "./fake-state.mjs";
const [webStorage, effortPath, harnessPath] = process.argv.slice(2, 5);
const jiti = createJiti(import.meta.url);
const storage = await jiti.import(webStorage);
const effort = await jiti.import(effortPath);
const { harness } = await jiti.import(harnessPath);
const { readStoredCredential } = await jiti.import("@earendil-works/pi-coding-agent");
const h = harness();
const thinking = process.argv[process.argv.indexOf("--thinking") + 1];
h.pi.getThinkingLevel = () => thinking;
let classifications = 0;
let changes = 0;
h.pi.setThinkingLevel = () => { changes++; };
const ctx = h.ctx({ cwd: process.cwd(), hasUI: false, mode: "rpc", model: { provider: "fixture", id: "model" }, modelRegistry: { classify: () => { classifications++; throw new Error("A pinned child must not classify"); } } });
await effort.default(h.pi);
await h.emit("session_start", {}, ctx);
const input = readline.createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
input.on("line", async (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send(stateResponse(command));
    return;
  }
  if (command.type !== "prompt") return;
  await h.emit("before_agent_start", { prompt: command.message }, ctx);
  const parentVisible = storage.getResult("parent-only") !== null;
  const previousChildVisible = storage.getResult("child-only") !== null;
  storage.storeResult("child-only", { id: "child-only", type: "search", timestamp: Date.now(), queries: [] });
  const credential = readStoredCredential("fixture", path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"));
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ parentVisible, previousChildVisible, childVisible: storage.getResult("child-only") !== null, authSeen: credential?.type === "api_key", pinned: effort.thinkingPinned(), thinking, classifications, changes, depth: process.env.PI_SUBAGENT_DEPTH }) }] } });
  send({ type: "agent_settled" });
  await h.emit("session_shutdown", {}, ctx);
});
