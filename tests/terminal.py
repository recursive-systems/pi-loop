#!/usr/bin/env python3
"""Run a command in a real pseudo-terminal (160x40) and relay bytes: our stdin to its input, its
output to our stdout. The end-to-end tests use it to drive Pi's interactive TUI, which needs a
terminal. Usage: terminal.py <command> [args...]"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))


def stop(*_):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, stop)
stdin = sys.stdin.fileno()
stdout = sys.stdout.fileno()
open_in = True
while True:
    fds = [master] + ([stdin] if open_in else [])
    try:
        ready = select.select(fds, [], [], 0.5)[0]
    except InterruptedError:
        continue
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(stdout, data)
    if open_in and stdin in ready:
        data = os.read(stdin, 65536)
        if not data:
            open_in = False
        else:
            os.write(master, data)
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        # Drain what is left.
        try:
            while select.select([master], [], [], 0.2)[0]:
                data = os.read(master, 65536)
                if not data:
                    break
                os.write(stdout, data)
        except OSError:
            pass
        sys.exit(os.waitstatus_to_exitcode(status))
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
