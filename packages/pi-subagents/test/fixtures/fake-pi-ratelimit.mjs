// A stand-in for `pi --mode rpc` whose one turn ends on the account's rate limit, as Pi reports it
// after its own retries.
import { createInterface } from "node:readline";
import { stateResponse } from "./fake-state.mjs";
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") {
    out(stateResponse(cmd));
  } else if (cmd.type === "prompt") {
    out({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    out({ type: "message_end", message: { role: "assistant", provider: "anthropic", model: "fake", content: [], stopReason: "error", errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}' } });
    out({ type: "agent_settled" });
  } else if (cmd.type === "abort") {
    out({ type: "agent_settled", aborted: true });
  }
});
rl.on("close", () => process.exit(0));
