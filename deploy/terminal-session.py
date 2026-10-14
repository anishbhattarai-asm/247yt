#!/usr/bin/env python3
# One session of the panel's Terminal tab: a login shell on a pseudo-terminal.
#
# systemd starts one of these per connection to the panel's terminal socket
# (stream-panel-terminal.socket) and hands over the connection as stdin and
# stdout. It runs as its own service, outside the panel's sandbox, so the
# shell can use sudo like an SSH login.
#
# Frames, both ways: 1 byte type, 4 bytes length (big-endian), payload.
#   panel -> here   b"d" keystrokes   b"r" resize: cols, rows (2 x uint16)
#   here -> panel   b"d" output       b"x" exit status (int32)
# When the panel hangs up, the shell and everything it started are ended
# (systemd stops this session's whole process group).

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def send(kind, payload=b""):
    frame = kind + struct.pack(">I", len(payload)) + payload
    view = memoryview(frame)
    while view:
        n = os.write(1, view)
        view = view[n:]


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except OSError as e:
            if e.errno == errno.EAGAIN:
                select.select([], [fd], [])
                continue
            raise
        view = view[n:]


def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ.setdefault("LANG", "C.UTF-8")
        shell = os.environ.get("SHELL") or "/bin/bash"
        os.execvp(shell, [shell, "-l"])

    resize(fd, 80, 24)
    pending = b""
    status = 0
    try:
        while True:
            ready, _, _ = select.select([0, fd], [], [])
            if fd in ready:
                try:
                    out = os.read(fd, 65536)
                except OSError:
                    out = b""  # EIO: the shell exited
                if not out:
                    break
                send(b"d", out)
            if 0 in ready:
                chunk = os.read(0, 65536)
                if not chunk:  # the panel hung up
                    os.kill(pid, signal.SIGHUP)
                    break
                pending += chunk
                while len(pending) >= 5:
                    (length,) = struct.unpack(">I", pending[1:5])
                    if len(pending) < 5 + length:
                        break
                    kind, payload = pending[:1], pending[5:5 + length]
                    pending = pending[5 + length:]
                    if kind == b"d":
                        write_all(fd, payload)
                    elif kind == b"r" and length == 4:
                        cols, rows = struct.unpack(">HH", payload)
                        resize(fd, max(cols, 10), max(rows, 3))
    finally:
        try:
            _, raw = os.waitpid(pid, 0)
            status = os.waitstatus_to_exitcode(raw)
        except ChildProcessError:
            pass
        try:
            send(b"x", struct.pack(">i", status))
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
