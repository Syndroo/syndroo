#!/usr/bin/env python3
"""Run a command on a real pseudo-terminal and report what happened.

The CLI's interactive path cannot be exercised by piping stdin: `process.stdin.isTTY`
stays false, and the code under test deliberately refuses to prompt without a
terminal. Node has no pty API, so this small driver allocates one.

Protocol
--------
* argv[1] is a base64-encoded JSON spec:
  ``{"argv": [...], "cwd": ..., "env": {...}, "trigger": "...", "timeoutMs": n}``
* The child's merged terminal output is returned as a JSON object on stdout:
  ``{"code": <exit status>, "output": "<terminal text>"}``.
* ``@@READY`` is written to this process's stderr when the trigger text has
  appeared, which is the signal for the caller to answer.
"""

import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def fail(message):
    sys.stdout.write(json.dumps({"code": -1, "output": "", "error": message}))
    sys.stdout.flush()
    sys.exit(0)


def main():
    if len(sys.argv) < 2:
        fail("missing spec")

    try:
        spec = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    except Exception as error:  # any decode problem is fatal here
        fail("bad spec: %s" % error)

    argv = spec["argv"]
    cwd = spec.get("cwd") or os.getcwd()
    env = spec.get("env") or os.environ
    trigger = spec.get("trigger") or ""
    timeout_ms = int(spec.get("timeoutMs") or 30000)

    pid, master = pty.fork()

    if pid == 0:
        try:
            os.chdir(cwd)
        except OSError:
            pass
        os.execvpe(argv[0], argv, env)

    # A wide window keeps long output lines from being wrapped, so the caller can
    # read a JSON result back out of the terminal stream.
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 200, 50, 0, 0))
    except OSError:
        pass

    output = []
    deadline = time.time() + (timeout_ms / 1000.0)
    triggered = False
    exited = False
    status = 0
    stdin_fd = sys.stdin.fileno()

    while True:
        if time.time() > deadline:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
            os.waitpid(pid, 0)
            fail("timeout after %dms" % timeout_ms)

        readable, _, _ = select.select([master, stdin_fd], [], [], 0.2)

        if master in readable:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                chunk = b"" if error.errno == errno.EIO else None
            if chunk:
                output.append(chunk.decode("utf-8", "replace"))
                if not triggered and trigger and trigger in "".join(output):
                    triggered = True
                    sys.stderr.write("@@READY\n")
                    sys.stderr.flush()

        if stdin_fd in readable:
            answer = os.read(stdin_fd, 65536)
            if answer:
                os.write(master, answer)

        if not exited:
            try:
                done, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                done, status = pid, 0
            if done == pid:
                exited = True
                break

    # Drain whatever the child wrote before it exited.
    while True:
        readable, _, _ = select.select([master], [], [], 0.1)
        if master not in readable:
            break
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.append(chunk.decode("utf-8", "replace"))

    try:
        os.close(master)
    except OSError:
        pass

    if os.WIFEXITED(status):
        code = os.WEXITSTATUS(status)
    elif os.WIFSIGNALED(status):
        code = -os.WTERMSIG(status)
    else:
        code = -1

    sys.stdout.write(json.dumps({"code": code, "output": "".join(output)}))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
