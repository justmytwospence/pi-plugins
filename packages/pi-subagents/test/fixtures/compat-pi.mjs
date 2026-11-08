// A deterministic RPC child using the actual web-access storage and Pi auth reader.
// It never loads web search/fetch, starts a server, or calls a classifier/provider.
import readline from "node:readline";
import path from "node:path";
import { createJiti } from "jiti";
import { stateResponse } from "./fake-state.mjs";
const [webStorage] = process.argv.slice(2, 3);
const jiti = createJiti(import.meta.url);
const storage = await jiti.import(webStorage);
const { readStoredCredential } = await jiti.import("@earendil-works/pi-coding-agent");
const thinking = process.argv[process.argv.indexOf("--thinking") + 1];
const input = readline.createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
input.on("line", async (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send(stateResponse(command));
    return;
  }
  if (command.type !== "prompt") return;
  const parentVisible = storage.getResult("parent-only") !== null;
  const previousChildVisible = storage.getResult("child-only") !== null;
  storage.storeResult("child-only", { id: "child-only", type: "search", timestamp: Date.now(), queries: [] });
  const credential = readStoredCredential("fixture", path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"));
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ parentVisible, previousChildVisible, childVisible: storage.getResult("child-only") !== null, authSeen: credential?.type === "api_key", pinned: process.argv.includes("--thinking"), thinking, depth: process.env.PI_SUBAGENT_DEPTH }) }] } });
  send({ type: "agent_settled" });
});
