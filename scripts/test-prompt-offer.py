#!/usr/bin/env python3
"""Offline real-Pi prompt-offer PTY regression; no remote model or marimo."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
TEXT = "/prompt-offer-test one  two"
DRAFT = "existing draft stays unchanged"
PROBE = r'''import { appendFileSync, existsSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  let tui, off, calls = 0, settled = false;
  pi.registerProvider("prompt-fixture", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture", api: "prompt-fixture",
    models: [{ id: "local", name: "Offline prompt fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const first = ++calls === 1;
      void (async () => {
        // Allow Python to type a real preexisting draft before the tool call.
        while (!existsSync(process.env.PROMPT_RELEASE)) await new Promise(r => setTimeout(r, 10));
        const content = first
          ? [{ type: "toolCall", id: "prompt-offer", name: "offer_prompt", arguments: { text: process.env.PROMPT_TEXT } }]
          : [{ type: "text", text: "PROMPT_FINAL_WITHOUT_TAG" }];
        const reason = first ? "toolUse" : "stop";
        const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
        stream.push({ type: "done", reason, message }); stream.end(message);
      })();
      return stream;
    }
  });
  pi.registerCommand("prompt-offer-test", { description: "Harmless offline sentinel", handler: async args => {
    appendFileSync(process.env.PROMPT_SENTINEL, JSON.stringify({ args }) + "\n");
  }});
  pi.on("agent_settled", () => { settled = true; });
  pi.on("session_shutdown", () => { off?.(); });
  pi.on("session_start", (_, ctx) => {
    ctx.ui.setWidget("prompt-test-probe", t => { tui = t; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("prompt-test-probe", undefined);
    off = ctx.ui.onTerminalInput(data => {
      if (data !== "\x1b[20~") return;
      // Observe only; never call render here (that could manufacture an acknowledgement).
      // Keep draft text in memory; the probe reports booleans only.
      appendFileSync(process.env.PROMPT_PROBE, JSON.stringify({
        emptyDraft: ctx.ui.getEditorText() === "",
        exactDraft: ctx.ui.getEditorText() === process.env.PROMPT_TEXT,
        unchangedDraft: ctx.ui.getEditorText() === process.env.PROMPT_DRAFT,
        started: calls > 0, final: calls === 2, settled,
        noOverlay: !tui.hasOverlay(),
        noShellCommand: !pi.getCommands().some(c => c.name === "interactive-shell")
      }) + "\n");
      return { consume: true };
    });
  });
}'''


def run(mode, preexisting):
    with tempfile.TemporaryDirectory(prefix="pi-prompt-pty-") as directory:
        temp = Path(directory)
        agent = temp / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"packages": [], "quietStartup": True, "cacheWarming": "off", "compaction": {"enabled": False}}))
        (agent / "next-prompt.json").write_text(json.dumps({"jev": {"enabled": False}}))
        fixture = temp / "probe.ts"
        fixture.write_text(PROBE)
        probe, sentinel, release = (temp / name for name in ("probe.jsonl", "sentinel.jsonl", "release"))
        sessions = temp / "sessions"
        sessions.mkdir()
        env = {key: value for key, value in os.environ.items() if not any(token in key.upper() for token in ("API_KEY", "ACCESS_TOKEN", "AUTH_TOKEN", "HERDR", "TMUX"))}
        env.update({"TERM": "xterm-256color", "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1",
                    "XDG_CONFIG_HOME": str(temp / "config"), "PROMPT_TEXT": TEXT, "PROMPT_DRAFT": DRAFT,
                    "PROMPT_PROBE": str(probe), "PROMPT_SENTINEL": str(sentinel), "PROMPT_RELEASE": str(release)})
        args = ["pi", "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
                "--no-themes", "--no-context-files", "--no-approve", "--session-dir", str(sessions),
                "--tui-mode", mode, "--provider", "prompt-fixture", "--model", "local"]
        # Explicit entries, never the suite: interactive-shell must not be loaded.
        for entry in (ROOT / "packages/pi-next-prompt/src/index.ts", ROOT / "packages/pi-vim/src/index.ts", fixture):
            args.extend(["-e", str(entry)])
        master, slave = pty.openpty()
        child = None
        transcript = bytearray()

        def own_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    break
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                transcript.extend(data)
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[c" in data:
                    os.write(master, b"\x1b[?1;2c")

        def send(keys):
            os.write(master, keys)
            drain(0.3)

        def snapshot():
            count = len(probe.read_text().splitlines()) if probe.exists() else 0
            send(b"\x1b[20~")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if probe.exists() and len(probe.read_text().splitlines()) > count:
                    result = json.loads(probe.read_text().splitlines()[-1])
                    assert all(isinstance(value, bool) for value in result.values()), result
                    assert result["noOverlay"] and result["noShellCommand"], result
                    return result
                assert child.poll() is None, f"Pi exited: {child.returncode}: {transcript[-3000:]!r}"
                drain(0.1)
            raise AssertionError(f"No boolean probe: {transcript[-4000:]!r}")

        def entries():
            return [json.loads(line) for path in sessions.rglob("*.jsonl") for line in path.read_text().splitlines()]

        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
            child = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, cwd=temp, env=env, preexec_fn=own_terminal)
            os.close(slave)
            slave = None
            drain(3)
            assert snapshot()["emptyDraft"]
            send(b"Offer the offline prompt fixture\r")
            assert snapshot()["started"]
            if preexisting:
                send(DRAFT.encode())
                assert snapshot()["unchangedDraft"]
            release.touch()
            deadline = time.monotonic() + 10
            state = snapshot()
            while not state["settled"] and time.monotonic() < deadline:
                drain(0.1)
                state = snapshot()
            assert state["settled"] and state["final"], state
            offer = next(e["message"] for e in entries() if e.get("message", {}).get("toolName") == "offer_prompt")
            finals = [c["text"] for e in entries() for c in e.get("message", {}).get("content", []) if isinstance(c, dict) and c.get("type") == "text"]
            assert "PROMPT_FINAL_WITHOUT_TAG" in finals, finals
            assert b"PROMPT_FINAL_WITHOUT_TAG" in transcript, transcript[-4000:]
            assert not sentinel.exists(), "Tool call executed the slash command"
            if preexisting:
                assert offer["details"]["status"] == "blocked" and offer.get("isError"), offer
                assert "draft" in offer["details"]["reason"].lower() or "empty" in offer["details"]["reason"].lower(), offer
                assert state["unchangedDraft"], state
                send(b"\t")
                assert snapshot()["unchangedDraft"]
                assert not sentinel.exists(), "Blocked offer executed"
            else:
                assert offer["details"]["status"] == "displayed" and not offer.get("isError"), offer
                assert offer["details"]["text"] == TEXT and offer["details"]["kind"] == "prompt", offer
                assert b"Displayed editable suggestion:" in transcript, transcript[-4000:]
                assert offer["details"]["surface"] == "ghost", offer
                assert TEXT.encode() in transcript, transcript[-4000:]
                assert state["emptyDraft"], state
                send(b"\t")
                accepted = snapshot()
                assert accepted["exactDraft"] and accepted["final"], accepted
                assert not sentinel.exists(), "Tab executed the slash command"
                send(b"\r")
                assert snapshot()["emptyDraft"]
                assert sentinel.exists(), "Enter did not invoke the slash command"
                assert [json.loads(line) for line in sentinel.read_text().splitlines()] == [{"args": "one  two"}]
                drain(0.5)
                assert len(sentinel.read_text().splitlines()) == 1, "Repeated slash invocation"
            print(f"PASS {mode} {'preexisting draft blocked unchanged' if preexisting else 'displayed ghost, tagless final, exact Tab draft, Enter once with exact arguments'}")
        finally:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            if slave is not None:
                os.close(slave)
            os.close(master)


if __name__ == "__main__":
    if not shutil.which("pi") or not shutil.which("node"):
        raise SystemExit("Required: pi and node on PATH (this regression must not skip)")
    for package in ("pi-next-prompt", "pi-vim"):
        if not (ROOT / "packages" / package / "node_modules").is_dir():
            raise SystemExit(f"Required: npm ci in packages/{package} (respect release-age policy)")
    for mode in ("regular", "fullscreen"):
        for preexisting in (False, True):
            run(mode, preexisting)
