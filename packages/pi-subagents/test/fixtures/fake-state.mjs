// The fake Pi chooses its own session path, just as native get_state does. It is deliberately
// unrelated to the run id or the fork source so tests cannot pass with an inferred filename.
import path from "node:path";
export function stateResponse(command, args = process.argv) {
  const dir = args[args.indexOf("--session-dir") + 1];
  const kind = args.includes("--fork") ? "forked" : "fresh";
  return {
    type: "response", id: command.id, command: "get_state", success: true,
    data: { sessionFile: path.join(dir, `pi-chose-${kind}-${process.pid}.jsonl`) },
  };
}
