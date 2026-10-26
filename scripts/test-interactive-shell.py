#!/usr/bin/env python3
"""Offline real-Pi PTY handoff test. Uses dummy input, never sudo or model calls."""
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
export default function(pi) {
  pi.on("session_start", (_, ctx) => {
    ctx.ui.onTerminalInput(data => {
      if (data === "\\x1b[19~") {
        pi.events.emit("prompt:offer", {source: "handoff-test", text: process.env.HANDOFF_COMMAND});
        return { consume: true };
      }
      if (data !== "\\x1b[20~") return;
      appendFileSync(process.env.HANDOFF_PROBE, JSON.stringify({text: ctx.ui.getEditorText(), idle: ctx.isIdle()}) + "\\n");
      return { consume: true };
    });
  });
}'''


def run(mode):
    with tempfile.TemporaryDirectory(prefix="pi-handoff-pty-") as directory:
        temp = Path(directory)
        agent = temp / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"packages": [], "quietStartup": True}))
        fixture = temp / "probe.ts"
        fixture.write_text(PROBE)
        probe = temp / "probe.jsonl"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
        env = {key: value for key, value in os.environ.items() if not any(token in key.upper() for token in ("API_KEY", "ACCESS_TOKEN", "AUTH_TOKEN", "HERDR", "TMUX"))}
        command = "!i read -s -p 'HANDOFF_INPUT: ' value; printf '\\nTERMINAL_ONLY:%s\\n' \"$value\""
        env.update({"TERM": "xterm-256color", "PI_CODING_AGENT_DIR": str(agent), "HANDOFF_PROBE": str(probe), "HANDOFF_COMMAND": command, "PI_OFFLINE": "1", "SHELL": "/bin/bash"})
        sessions_dir = temp / "sessions"
        sessions_dir.mkdir()
        seed = sessions_dir / "seed.jsonl"
        seed.write_text("\n".join(json.dumps(entry) for entry in [
            {"type": "session", "version": 3, "id": "00000000-0000-4000-8000-000000000001", "timestamp": "2026-10-26T00:00:00Z", "cwd": str(temp)},
            {"type": "message", "id": "00000001", "parentId": None, "timestamp": "2026-10-26T00:00:00Z", "message": {"role": "user", "content": "Offline handoff test fixture", "timestamp": 0}},
        ]) + "\n")
        args = ["pi", "--session", str(seed), "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session-dir", str(temp / "sessions"), "--tui-mode", mode, "-e", str(ROOT), "-e", str(fixture)]

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
            try:
                os.write(master, b"\x1b[20~")
            except OSError as error:
                child.wait(timeout=2)
                raise AssertionError(f"Pi exited {child.returncode}: {transcript[-4000:]!r}") from error
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                drain(0.1)
                if probe.exists() and len(probe.read_text().splitlines()) > count:
                    return json.loads(probe.read_text().splitlines()[-1])
                assert child.poll() is None, f"Pi exited: {child.returncode}: {transcript[-3000:]!r}"
            raise AssertionError(f"TUI did not resume: {transcript[-4000:]!r}")

        def submit(command):
            os.write(master, command.encode() + b"\r")
            drain(0.6)

        try:
            drain(3)
            assert snapshot()["idle"]
            os.write(master, b"\x1b[19~")  # Existing next-prompt offer integration.
            drain(0.1)
            os.write(master, b"\t")
            drain(0.1)
            assert snapshot() == {"text": command, "idle": True}  # Tab does not execute.
            os.write(master, b"\r")
            drain(0.6)
            assert b"HANDOFF_INPUT:" in transcript[-5000:]
            os.write(master, b"dummy-handoff-input\n")
            drain(0.8)
            assert snapshot() == {"text": "", "idle": True}
            assert b"TERMINAL_ONLY:dummy-handoff-input" in transcript
            submit("!i read -s -p 'INTERRUPT_ME: ' value")
            os.write(master, b"\x03")
            drain(0.8)
            assert snapshot() == {"text": "", "idle": True}
            submit("!i pi-handoff-nonexistent-command")
            assert snapshot()["idle"]
            submit("!!i printf 'EXCLUDED_HANDOFF_OUTPUT\\n'")
            assert snapshot()["idle"]
            # Ensure normal user-bash status recording works after restoring the terminal.
            submit("!printf NORMAL_BASH_OK")
            assert snapshot()["idle"]
            sessions = "\n".join(p.read_text() for p in (temp / "sessions").rglob("*.jsonl"))
            assert "interactive command exited with code 0" in sessions
            assert "127" in sessions and "NORMAL_BASH_OK" in sessions
            assert "dummy-handoff-input" not in sessions
            assert "TERMINAL_ONLY:dummy" not in sessions
            # Excluded bash may still be persisted, but must retain its context exclusion flag.
            excluded = [json.loads(line) for line in sessions.splitlines() if "EXCLUDED_HANDOFF_OUTPUT" in line]
            assert excluded and all(item.get("message", {}).get("excludeFromContext") is True for item in excluded), excluded
            print(f"PASS {mode}: full-suite real PTY handoff, non-echoing input, Ctrl+C, failed command, exclusion and UI restoration")
        finally:
            if child.poll() is None:
                # Kill the isolated test process group, including any interrupted shell.
                os.killpg(child.pid, signal.SIGKILL)
                _, status = os.waitpid(child.pid, 0)
                child.returncode = os.waitstatus_to_exitcode(status)
            os.close(master)


if __name__ == "__main__":
    for mode in ("fullscreen", "regular"):
        run(mode)
