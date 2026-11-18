#!/usr/bin/env python3
"""Runs a command on a real pty and performs steps on it, for term-resize.ts.

usage: term-resize-pty.py <steps as JSON> <cols> <rows> <cwd> <command> [args...]

A step is {"expect": pattern} (waits for the pattern in what the terminal
printed since the last match), {"type": text} or {"resize": [cols, rows]}.
Prints everything the terminal printed, as it printed it, on stdout. Exits 3
when a pattern does not show within ten seconds.
"""
import fcntl, json, os, pty, re, select, struct, sys, termios, time

steps = json.loads(sys.argv[1])
cols, rows, cwd, argv = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5:]
master, slave = pty.openpty()


def resize(columns, lines):
    # The kernel signals the foreground process group (SIGWINCH) when the size changes.
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", lines, columns, 0, 0))


resize(cols, rows)
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    os.close(master)
    os.close(slave)
    os.chdir(cwd)
    os.execvp(argv[0], argv)
os.close(slave)
printed = b""
cursor = 0


def pump(timeout):
    """Reads what the terminal printed, if anything comes within `timeout`. False once it has closed."""
    global printed
    if not select.select([master], [], [], timeout)[0]:
        return True
    try:
        data = os.read(master, 65536)
    except OSError:
        return False
    printed += data
    return len(data) > 0


for step in steps:
    if "expect" in step:
        deadline = time.time() + 10
        while True:
            found = re.search(step["expect"].encode(), printed[cursor:])
            if found:
                cursor += found.end()
                break
            if time.time() > deadline or not pump(0.05):
                sys.stderr.write("pattern %r did not show; printed since the last match: %r\n" % (step["expect"], printed[cursor:]))
                sys.stdout.buffer.write(printed)
                sys.exit(3)
    elif "type" in step:
        os.write(master, step["type"].encode())
    elif "resize" in step:
        resize(*step["resize"])
deadline = time.time() + 10
while time.time() < deadline and pump(0.1):
    pass
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(printed)
sys.stderr.write("exit %d\n" % os.WEXITSTATUS(status))
