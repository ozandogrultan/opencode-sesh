#!/usr/bin/env python3
"""Real fzf PTY regressions. All stores, homes and action commands are fixtures."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import shutil
import signal
import sqlite3
import struct
import subprocess
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
FZF = os.environ.get("SESH_TEST_FZF") or shutil.which("fzf")


def fzf_supports_picker():
    if not FZF:
        return False
    try:
        out = subprocess.run([FZF, "--version"], capture_output=True, text=True, timeout=10).stdout
    except OSError:
        return False
    match = re.match(r"(\d+)\.(\d+)", out)
    return bool(match) and (int(match.group(1)), int(match.group(2))) >= (0, 73)


@unittest.skipUnless(fzf_supports_picker(), "picker tests need fzf >= 0.73 (or SESH_TEST_FZF)")
class PickerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sesh-picker-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ("home", "cache", "tmp", "project", "bin"):
            (self.root / name).mkdir()
        self.db = self.root / "opencode.db"
        self.sql("""CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
            CREATE TABLE part (session_id TEXT, time_updated INTEGER, time_created INTEGER, data TEXT);""")
        self.add_session("alpha", 20)
        self.add_session("beta", 10)
        self.env = dict(os.environ, HOME=str(self.root / "home"),
            XDG_CONFIG_HOME=str(self.root / "home/config"),
            XDG_CACHE_HOME=str(self.root / "home/cache"),
            XDG_DATA_HOME=str(self.root / "home/data"), XDG_BIN_HOME=str(self.root / "home/bin"),
            TMPDIR=str(self.root / "tmp"), SESH_DB=str(self.db),
            SESH_CACHE_DIR=str(self.root / "cache"), SESH_SQLITE=shutil.which("sqlite3"),
            SESH_JQ=shutil.which("jq"), SESH_GLOW="/nonexistent/glow",
            TERM="xterm-256color", FZF_DEFAULT_OPTS="", FZF_DEFAULT_OPTS_FILE="")
        stub = self.root / "bin/opencode"
        stub.write_text(f"""#!{shutil.which('python3')}
import json, os, sqlite3, sys
from pathlib import Path
root = Path({str(self.root)!r})
if sys.argv[1:] == ['--version']:
    print('1.18.30'); sys.exit(0)
with (root / 'actions').open('a') as out:
    out.write(json.dumps(dict(args=sys.argv[1:], cwd=os.getcwd())) + '\\n')
if sys.argv[1:3] == ['session', 'delete']:
    with sqlite3.connect(root / 'opencode.db') as db:
        db.execute('DELETE FROM session WHERE id = ?', (sys.argv[3],))
""")
        stub.chmod(0o700)
        self.env["SESH_OPENCODE"] = str(stub)
        self.env["PATH"] = str(self.root / "bin") + os.pathsep + os.environ["PATH"]
        self.pid = None
        self.fd = None
        self.screen = b""
        self.addCleanup(self.stop)

    def sql(self, sql):
        with sqlite3.connect(self.db) as db:
            db.executescript(sql)

    def add_session(self, name, updated):
        with sqlite3.connect(self.db) as db:
            db.execute("INSERT INTO session VALUES (?, ?, ?, 1, ?, NULL)",
                       ("ses_" + name, str(self.root / "project"), "auth " + name, updated * 1000))

    def contents(self, name):
        path = self.root / name
        return path.read_text() if path.exists() else ""

    def start(self, *args):
        self.assertTrue(FZF, "fzf >= 0.73.0 is required (or set SESH_TEST_FZF)")
        # Instrument only observation events; production keys/reloads stay intact.
        wrapper = self.root / "bin/fzf"
        wrapper.write_text(f"""#!/bin/bash
if [ "${{1:-}}" != --version ]; then
  printf '%s\\n' "$*" >> {shlex.quote(str(self.root / 'invocations'))}
  exec {shlex.quote(FZF)} "$@" \\
    --bind {shlex.quote("load:execute-silent(printf '%s\\n' {6} >> " + shlex.quote(str(self.root / 'loads')) + ")")} \\
    --bind {shlex.quote("focus:execute-silent(printf '%s\\n' {6} > " + shlex.quote(str(self.root / 'focus')) + ")")}
fi
exec {shlex.quote(FZF)} "$@"
""")
        wrapper.chmod(0o700)
        self.env["SESH_FZF"] = str(wrapper)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
            out = os.open(self.root / "stdout", os.O_WRONLY | os.O_CREAT, 0o600)
            os.dup2(out, 1)
            os.chdir(self.root / "project")
            os.execve(ROOT / "bin/sesh.sh", [str(ROOT / "bin/sesh.sh"), *args], self.env)
        self.until(lambda: b"auth beta" in self.screen)
        self.key(b"\x0e\x0e")  # directory header -> alpha -> beta
        self.until(lambda: self.contents("focus").strip() == "ses_beta")

    def pump(self):
        if self.fd is not None and select.select([self.fd], [], [], 0.05)[0]:
            try:
                data = os.read(self.fd, 65536)
                self.screen += data
                if b"\x1b[6n" in data:
                    os.write(self.fd, b"\x1b[1;1R")
            except OSError:
                pass

    def until(self, condition, timeout=18):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            if condition():
                return
        self.fail("Timed out; screen tail: " + repr(self.screen[-2500:]))

    def key(self, data):
        try:
            os.write(self.fd, data)
        except OSError:
            # The child may already have exited (e.g. --print); teardown still
            # needs to be safe to call.
            pass

    def settle(self, seconds=0.5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()

    def stop(self):
        if self.pid:
            # Signal the picker, whose trap reaps its worker; fzf gets Escape.
            self.key(b"\x1b")
            os.kill(self.pid, signal.SIGTERM)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                self.pump()
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    break
            else:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
            os.close(self.fd)
            self.pid = self.fd = None

    def actions(self):
        return [json.loads(line) for line in self.contents("actions").splitlines()]

    def reorder(self):
        self.add_session("gamma", 30)
        self.sql("UPDATE session SET title = 'auth beta changed', time_updated = 40000 WHERE id = 'ses_beta'")
        self.until(lambda: b"auth gamma" in self.screen and b"auth beta changed" in self.screen)
        self.assertEqual(self.contents("loads").splitlines()[-1], "ses_beta")

    def test_resume_tracks_identity_and_preserves_query_on_return(self):
        self.start("--query", "auth")
        self.reorder()
        self.key(b"\r")
        self.until(lambda: len(self.contents("invocations").splitlines()) == 2)
        self.assertEqual(self.actions(), [dict(args=["--session", "ses_beta"], cwd=os.path.realpath(str(self.root / "project")))])
        self.assertIn("--query=auth ", self.contents("invocations").splitlines()[1])

    def test_delete_tracks_identity(self):
        self.start()
        self.reorder()
        self.key(b"\x18")
        self.until(lambda: bool(self.actions()))
        self.assertEqual(self.actions()[0]["args"], ["session", "delete", "ses_beta"])
        self.until(lambda: b"Selected session is no longer available" in self.screen)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT id FROM session ORDER BY id").fetchall(), [("ses_alpha",), ("ses_gamma",)])

    def disappearance(self, final=False):
        self.start("--query", "auth")
        self.sql("DELETE FROM session" if final else "DELETE FROM session WHERE id = 'ses_beta'")
        self.until(lambda: b"Selected session is no longer available" in self.screen)
        self.assertEqual(self.contents("loads").splitlines()[-1], "ses_beta")
        self.key(b"\x18")
        self.settle(0.5)
        self.assertEqual(self.actions(), [])
        self.key(b"\x06")
        self.until(lambda: len(self.contents("invocations").splitlines()) == 2)
        self.assertEqual(self.actions(), [])
        self.assertIn("--query=auth ", self.contents("invocations").splitlines()[1])

    def test_disappeared_selection_cannot_delete_or_fork_neighbor(self):
        self.disappearance()

    def test_final_session_disappearance_is_non_actionable(self):
        self.disappearance(final=True)

    def test_ctrl_f_accepts_as_fork(self):
        self.start("--query", "auth", "--print")
        self.key(b"\x06")
        self.until(lambda: "ses_beta" in self.contents("stdout"))
        self.assertEqual(self.contents("stdout"), f"ses_beta\t{self.root / 'project'}\tfork\n")

    def test_explicit_fork_with_enter(self):
        self.start("--fork", "--query", "auth")
        self.key(b"\r")
        self.until(lambda: bool(self.actions()))
        self.assertEqual(self.actions()[0]["args"], ["--session", "ses_beta", "--fork"])

    def test_literal_ctrl_f_query_does_not_fork(self):
        self.sql("UPDATE session SET title = 'ctrl-f auth ' || id")
        # Keep the initial titles recognizable to the PTY readiness check.
        self.sql("UPDATE session SET title = 'ctrl-f auth beta' WHERE id = 'ses_beta'")
        self.start("--query", "ctrl-f", "--print")
        self.key(b"\r")
        self.until(lambda: "ses_beta" in self.contents("stdout"))
        self.assertEqual(self.contents("stdout"), f"ses_beta\t{self.root / 'project'}\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
