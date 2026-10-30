#!/usr/bin/env python3
"""Offline full-suite Pi PTY test. Dummy input only; no sudo or remote model calls."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
PROBE = '''import { appendFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { resolveTranscript } from "RESOLVER_PATH";
export default function(pi) {
  let off;
  let tui;
  let calls = 0;
  let todoTail;
  let beforeOffer;
  const todoState = () => {
    const document = tui?.getPrimaryScrollView?.()?.child;
    const children = document?.children ?? [];
    const tail = children[3];
    return {
      documentChildren: children.length,
      todoTailAtThree: !!tail && tail === todoTail,
      todoTailLast: !!tail && children.at(-1) === tail,
      todoTailPlain: !!tail && tail.constructor === Object && !Array.isArray(tail.children),
      todoTailVisible: !!tail && typeof tail.render === "function" &&
        tail.render(tui.terminal.columns).join("\\n").includes("PTY terminal regression"),
    };
  };
  pi.registerProvider("terminal-fixture", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture", api: "terminal-fixture",
    models: [{ id: "local", name: "Local PTY fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      calls++;
      if (calls === 2) {
        // Observe the real todo extension's mounted tail before offer_terminal runs.
        todoTail = tui?.getPrimaryScrollView?.()?.child?.children?.[3];
        beforeOffer = todoState();
      }
      const content = calls === 1
        ? [{ type: "toolCall", id: "terminal-todo", name: "todo", arguments: { action: "create", subject: "PTY terminal regression" } }]
        : calls === 2
          ? [{ type: "toolCall", id: "terminal-offer", name: "offer_terminal", arguments: { command: process.env.HANDOFF_COMMAND.slice(3) } }]
          : [{ type: "text", text: calls === 3 ? "OFFER_FINAL_WITHOUT_TAG" : "CONTINUATION_FINAL_SENTINEL" }];
      const reason = calls <= 2 ? "toolUse" : "stop";
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: "done", reason, message }); stream.end(message); });
      return stream;
    }
  });
  pi.registerCommand("terminal-test-reload", {description: "Offline reload fixture", handler: async (_, ctx) => { await ctx.reload(); }});
  pi.on("session_shutdown", () => { off?.(); off = undefined; });
  pi.on("session_start", (_, ctx) => {
    ctx.ui.setWidget("terminal-test-probe", t => { tui = t; return {render: () => [], invalidate(){}}; });
    ctx.ui.setWidget("terminal-test-probe", undefined);
    let editor;
    const mounted = (target) => {
      const seen = new Set();
      const visit = (node, depth = 0) => {
        if (!node || typeof node !== "object" || seen.has(node) || depth > 20) return false;
        if (node === target) return true;
        seen.add(node);
        return [node.layoutRoot, node.child, ...(node.children ?? []), ...(node.entries ?? []).map(e => e.component)]
          .some(child => visit(child, depth + 1));
      };
      return visit(tui);
    };
    off?.();
    off = ctx.ui.onTerminalInput(data => {
      if (data === "\\x1b[18~") { pi.sendUserMessage("/terminal-test-reload", {expandPromptTemplates: true}); return { consume: true }; }
      if (data !== "\\x1b[20~") return;
      const focus = tui.getFocusedComponent();
      const terminal = focus?.[Symbol.for("pi-plugins.input-context.v1")]?.() === "terminal";
      if (!terminal && !editor) editor = focus;
      const resolved = resolveTranscript(tui);
      const children = resolved.chat?.children ?? [];
      const panel = children.find(child => child.constructor.name === "TerminalPanel");
      const lines = panel ? panel.render(tui.terminal.columns - 2) : [];
      const text = lines.join("\\n");
      const rendered = children.map(child => child.render(tui.terminal.columns).join("\\n"));
      const retained = rendered.findIndex(text => text.includes("output retained for this session") && text.includes("TERMINAL_ONLY:dummy-handoff-input"));
      const status = rendered.findIndex(text => text.includes("interactive command exited with code 0"));
      const continuation = rendered.findIndex(text => text.includes("CONTINUATION_FINAL_SENTINEL"));
      // Only booleans/geometry in this test probe, never terminal contents or typed keys.
      appendFileSync(process.env.HANDOFF_PROBE, JSON.stringify({
        exactDraft: ctx.ui.getEditorText() === process.env.HANDOFF_COMMAND,
        emptyDraft: ctx.ui.getEditorText() === "", terminal, height: lines.length,
        overlays: tui.hasOverlay(), editorMounted: mounted(editor), calls,
        beforeOffer, ...todoState(),
        layout: resolved.source ?? resolved.reason, focus: focus?.constructor.name,
        retained, status, continuation,
        frozenScroll: rendered.some(text => text.includes("SCROLL_000") && text.includes("SCROLL_079")),
        frozenScrollHead: rendered.some(text => text.includes("SCROLL_000")),
        frozenScrollTail: rendered.some(text => text.includes("SCROLL_079")),
        width: tui.terminal.columns, maxWidth: Math.max(0, ...lines.map(visibleWidth)),
        exited: text.includes("exited"), ready: text.includes("HANDOFF_INPUT:"),
        stop: text.includes("Stop command?"), menu: text.includes("MENU_READY"),
        scrollTop: text.includes("SCROLL_000"), scrollEnd: text.includes("SCROLL_079")
      }) + "\\n");
      return { consume: true };
    });
  });
}'''
MENU = '''import os,sys,termios,tty
fd=0
old=termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    os.write(1,b"\\x1b[?1049hMENU_READY")
    keys=b""
    while True:
        data=os.read(fd,1)
        if data==b"\\x04": break
        keys+=data
    os.write(1,b"\\x1b[?1049lMENU_DONE:"+keys.hex().encode()+b"\\r\\n")
finally:
    termios.tcsetattr(fd,termios.TCSANOW,old)
'''


def run(mode):
    with tempfile.TemporaryDirectory(prefix="pi-panel-pty-") as directory:
        temp = Path(directory)
        agent = temp / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"packages": [], "quietStartup": True, "cacheWarming": "off", "compaction": {"enabled": False}}))
        # Keep all exercised classifiers and cache warming offline, independent of user config.
        for name in ("next-prompt", "auto-effort", "cache-guard"):
            (agent / f"{name}.json").write_text(json.dumps({"jev": {"enabled": False}}))
        (agent / "tool-gate.json").write_text(json.dumps({"jev": {"enabled": False}, "defaultApproval": "bypassPermissions"}))
        fixture = temp / "probe.ts"
        fixture.write_text(PROBE.replace("RESOLVER_PATH", (ROOT / "packages/pi-interactive-shell/src/transcript.ts").as_posix()))
        menu = temp / "menu.py"
        menu.write_text(MENU)
        probe = temp / "probe.jsonl"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
        env = {key: value for key, value in os.environ.items() if not any(token in key.upper() for token in ("API_KEY", "ACCESS_TOKEN", "AUTH_TOKEN", "HERDR", "TMUX"))}
        command = "!i read -s -p 'HANDOFF_INPUT: ' value; printf '\\nTERMINAL_ONLY:%s\\n' \"$value\""
        env.update({"TERM": "xterm-256color", "PI_CODING_AGENT_DIR": str(agent), "HANDOFF_PROBE": str(probe), "HANDOFF_COMMAND": command, "PI_OFFLINE": "1", "SHELL": "/bin/bash", "XDG_CONFIG_HOME": str(temp / "config")})
        sessions_dir = temp / "sessions"
        sessions_dir.mkdir()
        seed = sessions_dir / "seed.jsonl"
        seed.write_text("\n".join(json.dumps(entry) for entry in [
            {"type": "session", "version": 3, "id": "00000000-0000-4000-8000-000000000001", "timestamp": "2026-10-26T00:00:00Z", "cwd": str(temp)},
            {"type": "message", "id": "00000001", "parentId": None, "timestamp": "2026-10-26T00:00:00Z", "message": {"role": "user", "content": "Offline panel test fixture\n" + "Resumed transcript fixture.\n" * 40, "timestamp": 0}},
            {"type": "message", "id": "00000002", "parentId": "00000001", "timestamp": "2026-10-26T00:00:01Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "RESUMED_ASSISTANT_FIXTURE"}], "api": "terminal-fixture", "provider": "terminal-fixture", "model": "local", "stopReason": "stop", "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}, "timestamp": 1}},
        ]) + "\n")
        args = ["pi", "--session", str(seed), "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session-dir", str(sessions_dir), "--tui-mode", mode, "--provider", "terminal-fixture", "--model", "local", "-e", str(ROOT), "-e", str(fixture)]

        def own_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        child = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, cwd=temp, env=env, preexec_fn=own_terminal)
        os.close(slave)
        transcript = bytearray()

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

        def snapshot():
            count = len(probe.read_text().splitlines()) if probe.exists() else 0
            os.write(master, b"\x1b[20~")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                drain(0.1)
                if probe.exists() and len(probe.read_text().splitlines()) > count:
                    result = json.loads(probe.read_text().splitlines()[-1])
                    assert result["maxWidth"] <= result["width"], result
                    assert not result["overlays"], result
                    if result["terminal"]:
                        assert not result["editorMounted"], result
                    return result
                assert child.poll() is None, f"Pi exited: {child.returncode}: {transcript[-3000:]!r}"
            raise AssertionError(f"No input probe: {transcript[-4000:]!r}")

        def send(keys):
            os.write(master, keys)
            drain(0.7)

        def submit(command):
            send(command.encode() + b"\r")

        def completed():
            state = snapshot()
            assert not state["terminal"] and not state["overlays"] and state["editorMounted"], state

        try:
            drain(3)
            assert not snapshot()["terminal"]
            submit("Offer the local terminal fixture")
            offered = snapshot()
            deadline = time.monotonic() + 8
            while offered["calls"] < 3 and time.monotonic() < deadline:
                drain(0.2)
                offered = snapshot()
            assert offered["calls"] == 3, offered
            if mode == "fullscreen":
                assert offered["beforeOffer"] == {
                    "documentChildren": 4, "todoTailAtThree": True, "todoTailLast": True,
                    "todoTailPlain": True, "todoTailVisible": True,
                }, offered
            entries = [json.loads(line) for line in seed.read_text().splitlines()]
            todo = next(e["message"] for e in entries if e.get("message", {}).get("toolName") == "todo")
            assert not todo.get("isError"), todo
            offer = next(e["message"] for e in entries if e.get("message", {}).get("toolName") == "offer_terminal")
            assert offer["details"]["status"] == "displayed" and not offer.get("isError"), offer
            assert offer["details"]["text"] == command, offer
            assert "OFFER_FINAL_WITHOUT_TAG" in seed.read_text()
            send(b"\t")
            accepted = snapshot()
            assert accepted["exactDraft"] and not accepted["terminal"] and accepted["calls"] == 3, accepted
            send(b"\r")
            compact = snapshot()
            assert compact["terminal"] and compact["ready"] and compact["height"] < 24, compact
            assert not compact["overlays"] and not compact["editorMounted"], compact
            if mode == "fullscreen":
                assert all(compact[key] for key in ("todoTailAtThree", "todoTailLast", "todoTailVisible")), compact
                assert compact["documentChildren"] == 4, compact
            send(b"\x1df")
            assert snapshot()["height"] > compact["height"]
            send(b"\x1df")
            send(b"dummy-handoff-input\r")
            completed()
            retained = snapshot()
            assert 0 <= retained["retained"] < retained["status"] < retained["continuation"], retained
            assert retained["calls"] == 4, retained
            if mode == "fullscreen":
                assert all(retained[key] for key in ("todoTailAtThree", "todoTailLast", "todoTailPlain", "todoTailVisible")), retained
                assert retained["documentChildren"] == 4, retained
            submit("!i read -s -p 'INTERRUPT_ME: ' value")
            send(b"\x03")
            completed()
            submit("!i pi-handoff-nonexistent-command")
            completed()
            submit(f"!i python3 {menu}")
            assert snapshot()["menu"]
            # Esc, arrows, Tab and Ctrl+T belong to the program, not Pi/editor navigation.
            send(b"\x1b[B\t\x14")
            send(b"\x1b")  # Let the host disambiguate literal Esc from an Alt chord.
            send(b"\x1d\x1d")
            send(b"\x04")
            assert b"MENU_DONE:1b5b4209141b1d" in transcript, transcript[-6000:]
            completed()
            submit("!i for ((i=0;i<80;i++)); do printf 'SCROLL_%03d\\n' \"$i\"; done; read -r reply")
            assert snapshot()["scrollEnd"]
            if mode == "fullscreen":
                # Real SGR wheel packets: find the live panel among transcript rows.
                # Footer/editor rows ignore these; stop as soon as the panel scrolls.
                wheel_row = None
                for row in range(30, 0, -1):
                    send(f"\x1b[<64;5;{row}M".encode())
                    if not snapshot()["scrollEnd"]:
                        wheel_row = row
                        break
                assert wheel_row is not None, "wheel never reached the live panel"
                send(f"\x1b[<65;5;{wheel_row}M".encode())
                assert snapshot()["scrollEnd"], snapshot()
            send(b"\x1dg")
            assert snapshot()["scrollTop"]
            send(b"\x1dG")
            assert snapshot()["scrollEnd"]
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 18, 46, 0, 0))
            os.kill(child.pid, signal.SIGWINCH)
            drain(0.3)
            assert snapshot()["width"] == 46
            # Restore enough rows for both retained ends, rather than a tiny tail-only view.
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
            os.kill(child.pid, signal.SIGWINCH)
            drain(0.3)
            assert snapshot()["width"] == 110
            send(b"\r")
            completed()
            assert snapshot()["frozenScroll"], snapshot()
            submit("!i read -p STOP_READY value")
            send(b"\x1dq")
            assert snapshot()["stop"]
            send(b"\x1b")
            assert snapshot()["terminal"] and not snapshot()["stop"]
            send(b"\x1dq\r")
            assert not snapshot()["terminal"]
            submit("!i read -p RELOAD_READY value")
            assert snapshot()["terminal"]
            send(b"\x1b[18~")
            drain(3)
            assert not snapshot()["terminal"]
            submit("!!i printf 'EXCLUDED_HANDOFF_OUTPUT\\n'")
            completed()
            submit("!printf NORMAL_BASH_OK")
            assert not snapshot()["terminal"]
            sessions = "\n".join(p.read_text() for p in sessions_dir.rglob("*.jsonl"))
            assert "interactive command exited with code 0" in sessions
            assert "127" in sessions and "NORMAL_BASH_OK" in sessions
            entries = [json.loads(line) for line in sessions.splitlines()]
            assert sum(e.get("type") == "custom_message" and e.get("customType") == "interactive-shell-continuation" for e in entries) == 1
            assert sum(any(c.get("text") == "CONTINUATION_FINAL_SENTINEL" for c in e.get("message", {}).get("content", []) if isinstance(c, dict)) for e in entries) == 1
            assert "dummy-handoff-input" not in sessions and "MENU_DONE:" not in sessions
            assert "SCROLL_000" not in sessions and "SCROLL_079" not in sessions
            excluded = [json.loads(line) for line in sessions.splitlines() if "EXCLUDED_HANDOFF_OUTPUT" in line]
            assert excluded and all(item.get("message", {}).get("excludeFromContext") is True for item in excluded), excluded
            print(f"PASS {mode}: real todo/offer_terminal calls, active todo tail preserved, tagless final, exact Tab/Enter, single continuation, inline/editor ownership, retained head/tail, privacy, Ctrl+C, program keys, expansion, wheel/keyboard scroll, resize, stop, reload, ordinary bash and exclusion")
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                _, status = os.waitpid(child.pid, 0)
                child.returncode = os.waitstatus_to_exitcode(status)
            os.close(master)


if __name__ == "__main__":
    for mode in ("fullscreen", "regular"):
        run(mode)
