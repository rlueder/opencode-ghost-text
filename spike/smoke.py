"""Exercise the installed OpenCode in a private PTY, without submitting a prompt.

Run: uv run --with pyte python spike/smoke.py
Only process-local CLI settings change. Captures stay under ignored artifacts/.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import time

import pyte

root = Path(__file__).resolve().parents[1]
artifacts = root / "spike" / "artifacts"
artifacts.mkdir(exist_ok=True)
diagnostic = artifacts / f"diagnostic-{os.getpid()}.jsonl"
screen = pyte.Screen(100, 30)
stream = pyte.Stream(screen)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
env = dict(os.environ)
model_session = env.get("GHOST_TEST_SESSION")
options = {"debug": str(diagnostic)}
if not model_session:
    options["suggestion"] = "Run the tests and fix any failures."
else:
    options.update({"model": "lmstudio/qwen/qwen3-4b-2507", "wordModel": "lmstudio/ibm/granite-4.1-8b", "timeoutMs": 30000, "wordTimeoutMs": 10000})
env["OPENCODE_CLI_CONFIG_CONTENT"] = json.dumps({
    "plugins": [{"package": str(root), "options": options}],
    "animations": False, "highlights": False,
    "debug": {"devtools": False},
})
env["TERM"] = "xterm-256color"
process = subprocess.Popen(
    ["opencode", *(["--session", model_session] if model_session else ["--standalone"]), str(root)],
    stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True,
)
os.close(slave)


def pump(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        # Answer terminal capability/cursor queries as a conservative xterm.
        if b"\x1b[6n" in data:
            os.write(master, b"\x1b[1;1R")
        if b"\x1b[c" in data or b"\x1b[0c" in data:
            os.write(master, b"\x1b[?1;2c")
        stream.feed(data.decode("utf-8", errors="replace"))
    return "\n".join(screen.display)


def capture(name, seconds=0.5):
    frame = pump(seconds)
    (artifacts / f"{name}.txt").write_text(frame)
    print(f"{name}: capture saved")
    return frame


try:
    initial = capture("01-startup", 10)
    if model_session:
        states = [json.loads(line) for line in diagnostic.read_text().splitlines()]
        state = states[-1]
        assert state["predictionLength"] > 0, "No model-backed suggestion appeared"
        assert state["editor"]["cursor"]["offset"] == 0, "Ghost changed the draft before Tab"
        os.write(master, b"\t")
        capture("model-accepted")
        states = [json.loads(line) for line in diagnostic.read_text().splitlines()]
        assert states[-1]["predictionLength"] == 0, "Accepted prediction was not consumed"
        assert states[-1]["editor"]["cursor"]["offset"] > 0, "Tab did not insert model suggestion"
        os.write(master, b"\x15")  # ctrl+u: clear the accepted single-line draft
        pump(0.3)
        os.write(master, b"Add reg")
        capture("word-preview", 5)
        states = [json.loads(line) for line in diagnostic.read_text().splitlines()]
        assert states[-1]["predictionKind"] == "word"
        assert states[-1]["predictionLength"] == len("Add regression"), "Not a fresh one-word completion"
        assert states[-1]["editor"]["cursor"]["offset"] == len("Add reg"), "Word ghost mutated the draft"
        os.write(master, b"\t")
        capture("word-accepted", 0.2)
        states = [json.loads(line) for line in diagnostic.read_text().splitlines()]
        assert states[-1]["editor"]["cursor"]["offset"] == len("Add regression"), "Tab must accept only the current word"
        os.write(master, b"\x10")
        pump(0.3)
        os.write(master, b"Ghost text: choose model")
        capture("model-command-search")
        os.write(master, b"\r")
        picker = capture("model-picker", 1)
        assert "Autocomplete model" in picker, "Model picker did not open"
        os.write(master, b"\x1b")
        pump(0.3)
        print("PASS: whole-prompt + fresh next-word generation via OpenCode, Tab acceptance, model picker; nothing submitted")
        raise SystemExit(0)
    assert "Run the tests and fix any failures." in initial, "Ghost missing at startup"
    os.write(master, b"Run the ")
    partial = capture("02-partial")
    assert "Run the tests and fix any failures." in partial
    os.write(master, b"\t")
    accepted = capture("03-accepted")
    assert "Run the tests and fix any failures." in accepted
    states = [json.loads(line) for line in diagnostic.read_text().splitlines()]
    assert states[-1]["editor"]["cursor"]["offset"] == 35, "Tab did not insert into editor"
    # Undo demonstrates that Tab really inserted text, not merely painted it.
    os.write(master, b"\x1b[45;5u")  # CSI-u ctrl+- (input.undo)
    undone = capture("04-undo")
    states = [json.loads(line) for line in diagnostic.read_text().splitlines()]
    assert states[-1]["editor"]["cursor"]["offset"] == 8, "Undo did not restore original prefix"
    os.write(master, b"\x1b")
    dismissed = capture("05-dismissed")
    assert "fix any failures." not in dismissed, "Ghost should disappear on Escape"
    assert "Run the " in dismissed, "Undo must preserve the original prefix"
    os.write(master, b"x\t")
    mismatch = capture("06-mismatch-tab")
    assert "Run the x" in mismatch and "fix any failures." not in mismatch
    os.write(master, b"\x10")  # ctrl+p: host command palette must still work
    palette = capture("07-command-palette")
    assert "fix any failures." not in palette
    print("PASS: inline display, actual Tab insertion + undo, Escape dismissal; no prompts submitted")
finally:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
