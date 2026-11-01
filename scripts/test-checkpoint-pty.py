#!/usr/bin/env python3
"""Actual-CLI, source-suite Ctrl+U/D regression; standard library only.

Run python3 scripts/test-checkpoint-pty.py. PI_CHECKPOINT_CLI overrides which(pi)
with an executable, not an internal cli.js or shell command. No prompts/Enter or
model calls: only synthetic history, editor keys and an observational F9 probe.
HOME/config/cwd/env are isolated. macOS sandbox-exec MUST deny network access;
missing CLI or unavailable sandbox is an explicit successful SKIP, never fallback.
"""
import errno
import json
import os
from pathlib import Path
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
F9 = b"\x1b[20~"
TURNS = 30
MODEL = "claude-sonnet-4-6"  # Synthetic session metadata only; no provider requests.
PROFILE = "(version 1) (allow default) (deny network*)"
PROBE = r'''import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { matchesKey } from "@earendil-works/pi-tui";
import { primaryTranscriptView, transcriptDocument, transcriptViewWidth, captureTranscript } from VIEWPORT;
import { indexTranscript, selectCheckpoint } from INDEX;
import { resolveTuiRuntime } from RUNTIME;
export default function(pi) {
  const violations = [];
  // Defense in depth: accidental submission is handled locally, not sent.
  pi.on("input", e => { violations.push(e.type); return { action: "handled" }; });
  pi.on("agent_start", (e, ctx) => { violations.push(e.type); ctx.abort(); });
  pi.on("before_provider_request", e => { violations.push(e.type); });
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("session_start", (_, ctx) => {
    let proxy;
    ctx.ui.setWidget("checkpoint-pty", t => { proxy=t; return {render:()=>[],invalidate(){}}; });
    ctx.ui.setWidget("checkpoint-pty", undefined);
    ctx.ui.onTerminalInput(data => {
      if (!matchesKey(data, "f9")) return;
      const out = {violations:[...violations],idle:ctx.isIdle()};
      try {
        // Startup can replace the renderer behind the stable TUI Proxy.
        const tui=resolveTuiRuntime(proxy), focus=tui.getFocusedComponent();
        const editor=typeof focus?.getText==="function" ? focus : focus?.editor?.();
        Object.assign(out, {rendererMode:tui.mode,kitty:tui.terminal.kittyProtocolActive===true,
          focus:focus?.constructor?.name,surface:editor?.[Symbol.for("pi-plugins.editor-surface.v1")],
          mode:editor?.[Symbol.for("pi-plugins.editor-mode.v1")]?.(),
          input:focus?.[Symbol.for("pi-plugins.input-context.v1")]?.(),
          text:ctx.ui.getEditorText(),localText:editor?.getText?.(),cursor:editor?.getCursor?.(),
          messages:ctx.sessionManager.getBranch().filter(e=>e.type==="message").map(e=>e.message.role)});
        const view=primaryTranscriptView(tui), doc=view&&transcriptDocument(view);
        const width=view&&transcriptViewWidth(tui,view);
        Object.assign(out,{primary:!!view,capture:!!captureTranscript(tui),index:null,
          scroll:view?{top:view.scrollTop,height:view.viewportHeight}:null});
        const boxes=[], pending=tui.currentLayout?.root?[tui.currentLayout.root]:[];
        while(pending.length && boxes.length<10000) {
          const b=pending.pop(); boxes.push(b); if(Array.isArray(b.children))pending.push(...b.children);
        }
        out.layout=boxes.filter(b=>b.component===view||b.scrollView===view).map(b=>({
          component:b.component?.constructor?.name,byComponent:b.component===view,
          byScrollView:b.scrollView===view,rect:b.rect,lines:b.scrollContentLines?.length}));
        if(doc && width!==undefined) {
          const index=indexTranscript(doc,view.getContentWidth(width));
          const checkpoints=index.blocks.filter(b=>b.checkpoint).map(b=>({start:b.start,end:b.end,...b.checkpoint}));
          const max=Math.max(0,index.lines.length-view.viewportHeight);
          out.index={lines:index.lines.length,checkpoints,
            targets:[...new Set(checkpoints.map(b=>Math.max(0,Math.min(max,b.start-1))))].sort((a,b)=>a-b),
            up:selectCheckpoint(index,view.scrollTop,view.viewportHeight,-1)??null,
            down:selectCheckpoint(index,view.scrollTop,view.viewportHeight,1)??null,
            digest:createHash("sha256").update(JSON.stringify([index.lines,checkpoints])).digest("hex")};
        }
      } catch(e) {out.error=String(e);out.stack=e.stack;}
      appendFileSync(process.env.PI_CHECKPOINT_PROBE,JSON.stringify(out)+"\n");
      return {consume:true};
    });
  });
}
'''


def environment(temp):
    home = temp / "home"
    agent = home / ".pi/agent"
    agent.mkdir(parents=True)
    # No inherited credentials, agent/session, proxy, NODE_OPTIONS or loader env.
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ") if k in os.environ}
    env.update({"HOME": str(home), "TERM": "xterm-256color", "NO_COLOR": "1",
                "PI_CODING_AGENT_DIR": str(agent), "PI_CODING_AGENT_SESSION_DIR": str(agent / "sessions"),
                "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "PI_CHECKPOINT_PROBE": str(temp / "probe.jsonl")})
    for key, path in {"XDG_CONFIG_HOME": home / ".config", "XDG_DATA_HOME": home / ".local/share",
                      "XDG_CACHE_HOME": home / ".cache", "XDG_STATE_HOME": home / ".local/state",
                      "XDG_RUNTIME_DIR": temp / "runtime", "TMPDIR": temp / "tmp"}.items():
        path.mkdir(parents=True, mode=0o700)
        env[key] = str(path)
    return env, agent


def seed_session(path, cwd):
    stamp = "2026-01-01T00:00:00.000Z"
    entries = [{"type": "session", "version": 3, "id": str(uuid.uuid4()), "timestamp": stamp, "cwd": str(cwd)}]
    parent = None
    for turn in range(TURNS):
        for role in ("user", "assistant"):
            ident = f"{turn:04d}{role[:4]}"
            message = {"role": role, "timestamp": 1767225600000 + turn, "content": [{"type": "text",
                       "text": f"Offline fixture {role} {turn}\n" + "\n".join(
                           f"Fixture line {n}: deterministic offline text." for n in range(8))}]}
            if role == "assistant":
                message.update({"api": "anthropic-messages", "provider": "anthropic", "model": MODEL,
                                "stopReason": "stop", "usage": {"input": 0, "output": 0, "cacheRead": 0,
                                "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0,
                                "cacheRead": 0, "cacheWrite": 0, "total": 0}}})
            entries.append({"type": "message", "id": ident, "parentId": parent, "timestamp": stamp, "message": message})
            parent = ident
    path.write_text("".join(json.dumps(e) + "\n" for e in entries))


def require(condition, label, value):
    if not condition:
        raise AssertionError(f"{label}: {json.dumps(value, sort_keys=True)}")


def sandbox_available(sandbox):
    with tempfile.TemporaryDirectory(prefix="pi-checkpoint-sandbox-") as directory:
        temp = Path(directory)
        env, _ = environment(temp)
        # Verify OS enforcement before starting Pi: only a sandboxed localhost
        # connection is attempted. ECONNREFUSED does NOT count as network denial.
        code = ("import errno,socket,sys\ntry:\n s=socket.socket(); r=s.connect_ex(('127.0.0.1',9))\n"
                "except OSError as e: r=e.errno\nsys.exit(0 if r in (errno.EPERM,errno.EACCES) else 1)\n")
        try:
            result = subprocess.run([sandbox, "-p", PROFILE, sys.executable, "-I", "-c", code],
                                    cwd=temp, env=env, capture_output=True, timeout=10)
            return result.returncode == 0, result.stderr.decode(errors="replace").strip()
        except (OSError, subprocess.TimeoutExpired) as error:
            return False, str(error)


def run(cli, sandbox, mode, native=False):
    import fcntl
    import pty
    import termios

    label = mode + ("/native-halfpage" if native else "/stock")
    with tempfile.TemporaryDirectory(prefix="pi-checkpoint-pty-") as directory:
        temp = Path(directory)
        env, agent = environment(temp)
        (agent / "settings.json").write_text(json.dumps({"packages": [], "quietStartup": True, "tuiMode": mode,
            "defaultProvider": "anthropic", "defaultModel": MODEL, "compaction": {"enabled": False},
            "retry": {"enabled": False}, "cacheWarming": "off", "doubleEscapeAction": "none"}))
        # NEVER disable app.exit: default stock Ctrl+D must remain independently
        # protected. The extra run exposes fullscreen/Vim/CC-render composition.
        if native:
            (agent / "keybindings.json").write_text(json.dumps({
                "tui.altScreen.halfPageUp": ["ctrl+u"], "tui.altScreen.halfPageDown": ["ctrl+d"]}))
        fixture, probe, session = temp / "fixture.ts", temp / "probe.jsonl", temp / "seed.jsonl"
        fixture.write_text(PROBE.replace("VIEWPORT", json.dumps(str(ROOT / "shared/transcript/transcript-viewport.ts")))
            .replace("INDEX", json.dumps(str(ROOT / "shared/transcript/transcript-index.ts")))
            .replace("RUNTIME", json.dumps(str(ROOT / "packages/pi-vim/src/tui-runtime.ts"))))
        seed_session(session, temp)
        seed_messages = [e for e in session.read_text().splitlines() if json.loads(e)["type"] == "message"]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        args = [sandbox, "-p", PROFILE, cli, "--offline", "--session", str(session),
                "--provider", "anthropic", "--model", MODEL, "--no-extensions", "--no-mcp", "--no-skills",
                "--no-tools", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
                "--tui-mode", mode, "-e", str(ROOT), "-e", str(fixture)]  # FULL SOURCE SUITE.
        try:
            child = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave,
                                     cwd=temp, env=env, start_new_session=True)
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        transcript, tail, snapshots = bytearray(), b"", 0

        def drain(deadline):
            nonlocal tail
            while time.monotonic() < deadline:
                if not select.select([master], [], [], max(0, deadline - time.monotonic()))[0]:
                    return
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not data:
                    return
                transcript.extend(data)
                del transcript[:-16000]
                combined = tail + data
                for query, reply in ((b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?1;2c"),
                                     (b"\x1b[?u", b"\x1b[?31u")):
                    # Answer split terminal negotiation queries, never app commands.
                    for pos in range(len(combined)):
                        if combined.startswith(query, pos) and pos + len(query) > len(tail):
                            os.write(master, reply)
                tail = combined[-8:]

        def snapshot(stage, keys=b"", startup=False):
            nonlocal snapshots
            require(child.poll() is None, f"{label}/{stage}: CLI exited", bytes(transcript[-5000:]).decode(errors="replace"))
            if keys:
                os.write(master, keys)
                drain(time.monotonic() + 0.15)
            count = len(probe.read_text().splitlines()) if probe.exists() else 0
            os.write(master, F9)
            deadline, resend = time.monotonic() + (20 if startup else 8), time.monotonic() + 0.5
            while time.monotonic() < deadline:
                drain(min(deadline, time.monotonic() + 0.05))
                lines = probe.read_text().splitlines() if probe.exists() else []
                if len(lines) > count:
                    out = json.loads(lines[-1])
                    snapshots += 1
                    require(not out.get("error") and not out["violations"] and out["idle"], stage, out)
                    require(out["messages"] == ["user", "assistant"] * TURNS, "history changed", out)
                    require(out.get("surface") == "main" and out.get("input") == "editor" and
                            out.get("mode") and out.get("cursor") is not None, "real main editor not focused", out)
                    return out
                require(child.poll() is None, f"{label}/{stage}: CLI exited {child.returncode}",
                        bytes(transcript[-5000:]).decode(errors="replace"))
                if startup and time.monotonic() >= resend:
                    os.write(master, F9)  # First probe may precede session_start.
                    resend = time.monotonic() + 0.5
            raise AssertionError(f"{label}/{stage}: no F9 response: {bytes(transcript[-5000:])!r}")

        def key(before, stage, data, direction, release=False):
            after = snapshot(stage, data)
            fields = ("text", "localText", "cursor", "mode", "surface", "input", "focus", "rendererMode")
            require(all(after.get(k) == before.get(k) for k in fields), f"{stage}: draft/cursor/mode changed", after)
            if mode == "regular":
                require(not after["primary"] and not after["capture"] and after["scroll"] is None,
                        f"{stage}: regular keys must be consumed without scrolling", after)
                return after
            # Startup health/ANSI paints may change without changing navigation geometry.
            # Require the same actual row map, not byte-identical styling between frames.
            stable_geometry = (after["index"] and before["index"]["lines"] == after["index"]["lines"] and
                               before["index"]["checkpoints"] == after["index"]["checkpoints"])
            require(after["capture"] and stable_geometry, f"{stage}: source geometry unavailable/changed",
                    {"before": {"lines": before["index"]["lines"], "height": before["scroll"]["height"],
                                "checkpoints": before["index"]["checkpoints"]}, "after": after})
            top, height = before["scroll"]["top"], before["scroll"]["height"]
            rows = [r for r in before["index"]["targets"] if (r < top if direction < 0 else r > top)]
            target = (rows[-1] if direction < 0 else rows[0]) if rows else None
            require(target == before["index"]["up" if direction < 0 else "down"], "source selector disagrees with index", before)
            # A scroll-status widget can change the dock budget after the key.
            # The SDK may clamp the chosen row to that final viewport's maximum.
            final_maximum = max(0, after["index"]["lines"] - after["scroll"]["height"])
            expected = max(0, min(final_maximum, top if release or target is None else target))
            maximum = max(0, before["index"]["lines"] - height)
            halfpage = max(0, min(maximum, top + direction * max(1, height // 2)))
            require(after["scroll"]["top"] == expected,
                    f"{label}/{stage}: from={top}, checkpoint={expected} (delta {expected-top}), "
                    f"actual={after['scroll']['top']} (delta {after['scroll']['top']-top}), "
                    f"native-halfpage={halfpage} (delta {halfpage-top}), release={release}", after)
            return after

        def case(current, state, text):
            name = f"{state}/{'nonempty' if text else 'empty'}"
            require(current["mode"]["state"] == state and current["mode"]["pending"] == "" and
                    current["text"] == current["localText"] == text, f"{name}: setup", current)
            for title, data, direction in (("raw-up", b"\x15", -1), ("raw-up-repeat", b"\x15", -1), ("raw-down", b"\x04", 1)):
                current = key(current, f"{name}/{title}", data, direction)
            if current["kitty"]:
                for char, direction in (("u", -1), ("d", 1)):
                    for event, title in ((1, "press"), (2, "repeat"), (3, "release")):
                        if event == 3 and mode == "fullscreen":
                            require(current["index"]["up"] is not None and current["index"]["down"] is not None,
                                    "release must be tested at an interior checkpoint", current)
                        current = key(current, f"{name}/kitty-{char}-{title}",
                                      f"\x1b[{ord(char)};5:{event}u".encode(), direction, release=event == 3)
            else:
                print(f"SKIP {label}/{name}: Kitty protocol not negotiated", flush=True)
            current = key(current, f"{name}/raw-down-again", b"\x04", 1)
            print(f"PASS {label}/{name}: Ctrl+U/D targets, unchanged draft/cursor/mode", flush=True)
            return current

        try:
            current = snapshot("startup", startup=True)
            require(current["rendererMode"] == mode, "requested renderer mode not active", current)
            if mode == "fullscreen":
                require(current["primary"] and current["capture"] and current["index"], "fullscreen source capture unavailable", current)
                kinds = [b["kind"] for b in current["index"]["checkpoints"]]
                require(kinds.count("prompt") == kinds.count("response") == TURNS and len(current["index"]["targets"]) > 10,
                        "source index must expose every seeded user AND assistant checkpoint", current)
            current = case(current, "insert", "")
            draft = "checkpoint draft stays unchanged"
            current = case(snapshot("type-draft", draft.encode() + b"\x1b[D\x1b[D\x1b[D"), "insert", draft)
            current = case(snapshot("normal", b"\x1b"), "normal", draft)
            current = case(snapshot("clear-draft", b"0D"), "normal", "")
            if mode == "fullscreen":
                for direction, data, name in ((-1, b"\x15", "top"), (1, b"\x04", "bottom")):
                    for step in range(len(current["index"]["targets"]) + 2):
                        previous = current["scroll"]["top"]
                        current = key(current, f"walk-{name}-{step}", data, direction)
                        if current["scroll"]["top"] == previous:
                            current = key(current, f"{name}-clamp", data, direction)
                            break
                    else:
                        raise AssertionError(f"{label}: checkpoint walk did not reach {name}")
            current = snapshot("empty-insert", b"i")
            key(current, "empty-insert-ctrl-d", b"\x04", 1)
            require([e for e in session.read_text().splitlines() if json.loads(e)["type"] == "message"] == seed_messages,
                    "persisted synthetic history changed", {})
            print(f"PASS {label}: {snapshots} snapshots; boundaries/empty Ctrl+D alive; no prompts/model activity", flush=True)
        finally:
            try:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
            finally:
                os.close(master)


def main():
    requested = os.environ.get("PI_CHECKPOINT_CLI")
    cli = shutil.which(requested) if requested is not None else shutil.which("pi")
    if not cli:
        print("SKIP checkpoint PTY: actual CLI absent (PI_CHECKPOINT_CLI may name an executable)")
        return 0
    sandbox = shutil.which("sandbox-exec") if sys.platform == "darwin" else None
    if not sandbox:
        print("SKIP checkpoint PTY: macOS sandbox-exec unavailable; refusing unprotected network")
        return 0
    available, reason = sandbox_available(sandbox)
    if not available:
        print(f"SKIP checkpoint PTY: OS network denial unavailable: {reason or 'enforcement not verified'}")
        return 0
    print(f"Checkpoint PTY: CLI={cli}; full source suite={ROOT}; OS network denied; stock app.exit", flush=True)
    failures = 0
    for mode, native in (("regular", False), ("fullscreen", False), ("fullscreen", True)):
        try:
            run(cli, sandbox, mode, native)
        except (AssertionError, OSError, subprocess.SubprocessError) as error:
            failures += 1
            print(f"FAIL {mode}{'/native-halfpage' if native else '/stock'}: {error}", file=sys.stderr, flush=True)
    print(f"{'FAIL' if failures else 'PASS'} checkpoint PTY: {failures}/3 runs failed", flush=True)
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
