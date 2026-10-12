#!/usr/bin/env python3
"""Offline Pi input smoke test in an isolated PTY. Never submits a model prompt."""
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
CLI = os.environ.get("PI_TEST_CLI", "/opt/homebrew/Cellar/pi-coding-agent/1.1.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
F9 = b"\x1b[20~"
PROBE = '''import { appendFileSync } from "node:fs";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { QuestionDialog } from QUESTION;
import { embeddedEditorFactory } from FACTORY;
export default function(pi) {
  let off;
  const question = ctx => ctx.ui.custom((tui, theme, kb, done) => new QuestionDialog(tui, theme, kb, [{ question: "Choose", header: "Test", options: [{label:"A",description:""},{label:"B",description:""}], multiSelect:false }], done, undefined, embeddedEditorFactory(pi)));
  pi.on("session_start", (_, ctx) => {
    off?.();
    let tui;
    ctx.ui.setWidget("audit-probe", t => { tui = t; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("audit-probe", undefined);
    off = ctx.ui.onTerminalInput(data => {
      if (matchesKey(data, "f8")) { void question(ctx); return { consume: true }; }
      if (!matchesKey(data, "f9")) return;
      const focus = tui.getFocusedComponent();
      const editor = typeof focus?.getText === "function" ? focus : focus?.editor?.();
      const mode = editor?.[Symbol.for("pi-plugins.editor-mode.v1")]?.();
      const input = focus?.[Symbol.for("pi-plugins.input-context.v1")]?.();
      appendFileSync(process.env.PI_AUDIT_PROBE, JSON.stringify({ text: ctx.ui.getEditorText(), localText: editor?.getText?.(), cursor: editor?.getCursor?.(), mode, input, focus: focus?.constructor?.name, width: tui.terminal.columns, maxWidth: Math.max(0, ...focus.render(tui.terminal.columns).map(visibleWidth)) }) + "\\n");
      return { consume: true };
    });
  });
  pi.on("session_shutdown", () => { off?.(); off = undefined; });
  pi.registerCommand("audit-question", { description: "Offline input fixture", handler: async (_, ctx) => {
    await question(ctx);
  }});
}
'''


def run(mode, vim=True):
    with tempfile.TemporaryDirectory(prefix="pi-input-pty-") as directory:
        temp = Path(directory)
        agent = temp / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"packages": [], "quietStartup": True, "tuiMode": mode}))
        (agent / "keybindings.json").write_text(json.dumps({"app.model.select": ["alt+p", "alt+m"], "app.model.cycleForward": [], "app.model.cycleBackward": [], "tui.select.down": ["down", "ctrl+j"], "tui.select.up": ["up", "ctrl+k"]}))
        probe = temp / "probe.jsonl"
        fixture = temp / "fixture.ts"
        fixture.write_text(PROBE.replace("QUESTION", json.dumps(str(ROOT / "packages/pi-ask-user-question/src/dialog.ts"))).replace("FACTORY", json.dumps(str(ROOT / "packages/pi-ask-user-question/src/editor.ts"))))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        env = {key: value for key, value in os.environ.items() if not any(token in key.upper() for token in ("API_KEY", "ACCESS_TOKEN", "AUTH_TOKEN", "HERDR", "TMUX"))}
        env.update({"TERM": "xterm-256color", "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "PI_AUDIT_PROBE": str(probe), "NO_COLOR": "1", "ANTHROPIC_API_KEY": "offline-test-not-a-credential"})
        args = [shutil.which("node"), CLI, "--offline", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--tui-mode", mode]
        for name in ("pi-vim", "pi-clear-screen", "pi-select-nav", "pi-stash", "pi-sticky-last-prompt", "pi-next-prompt", "pi-ask-user-question"):
            if name == "pi-vim" and not vim:
                continue
            args += ["-e", str(ROOT / "packages" / name / "src/index.ts")]
        args += ["-e", str(fixture)]
        child = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, cwd=temp, env=env, start_new_session=True)
        os.close(slave)
        transcript = bytearray()

        def drain(deadline):
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    return
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return
                if not data:
                    return
                transcript.extend(data)
                # Answer terminal device/cursor queries, not application commands.
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[c" in data:
                    os.write(master, b"\x1b[?1;2c")

        def snapshot(keys=b""):
            count = len(probe.read_text().splitlines()) if probe.exists() else 0
            if keys:
                os.write(master, keys)
                drain(time.monotonic() + 0.12)
            os.write(master, F9)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                drain(min(deadline, time.monotonic() + 0.1))
                if probe.exists():
                    lines = probe.read_text().splitlines()
                    if len(lines) > count:
                        value = json.loads(lines[-1])
                        assert value["maxWidth"] <= value["width"], value
                        return value
                if child.poll() is not None:
                    raise AssertionError(f"Pi exited: {child.returncode}: {transcript[-4000:]!r}")
            raise AssertionError(f"No PTY probe response: {transcript[-4000:]!r}")

        try:
            drain(time.monotonic() + 2)
            initial = snapshot()
            if vim:
                assert initial["mode"]["state"] == "insert", initial
            inserted = snapshot(b"draft")
            assert inserted["text"] == "draft", inserted
            deleted = snapshot(b"\x15")  # Ctrl+U belongs to Insert editing.
            assert deleted["text"] == "", deleted
            normal = snapshot(b"draft\x1b" if vim else b"draft")
            if vim:
                assert normal["mode"]["state"] == "normal", normal
                scrolled = snapshot(b"\x04\x15")
                assert scrolled["text"] == "draft" and scrolled["mode"]["state"] == "normal", scrolled
            stashed = snapshot(b"\x13")
            assert stashed["text"] == "", stashed
            restored = snapshot(b"\x13")
            assert restored["text"] == "draft", restored
            if vim:
                assert restored["cursor"] == normal["cursor"] and restored["mode"]["mode"] == normal["mode"]["mode"], restored
            cleared = snapshot(b"\x0c")
            assert cleared["text"] == "draft", cleared
            if vim:
                assert cleared["mode"]["state"] == "normal", cleared
            picker = snapshot(b"\x1bp")
            assert "Model" in picker["focus"], picker
            returned = snapshot(b"\x1b")
            assert returned["text"] == "draft", returned
            if vim:
                assert returned["mode"]["mode"] == normal["mode"]["mode"], returned
            # F8 uses the same real dialog without submitting any prompt in native mode.
            opened = snapshot(b":audit-question\r" if vim else b"\x1b[19~")
            assert opened["input"] == "list", opened
            composing = snapshot(b"nnotes\n")
            assert composing["input"] == "editor" and composing["localText"] == "notes\n", composing
            first = snapshot(b"\x1b")
            if vim:
                assert first["input"] == "editor" and first["mode"]["state"] == "normal", first
                second = snapshot(b"\x1b")
                assert second["input"] == "list", second
            else:
                assert first["input"] == "list", first
            closed = snapshot(b"\x1b")
            assert closed["text"] == "draft", closed
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 24, 0, 0))
            os.kill(child.pid, signal.SIGWINCH)
            narrow = snapshot()
            assert narrow["width"] == 24, narrow
            editor_name = "Vim" if vim else "native fallback"
            print(f"PASS offline {mode} {editor_name} PTY: editing, stash, clearing, model picker, nested focus and resize")
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            os.close(master)


if __name__ == "__main__":
    for tui_mode in ("fullscreen", "regular"):
        for modal_editor in (True, False):
            run(tui_mode, vim=modal_editor)
