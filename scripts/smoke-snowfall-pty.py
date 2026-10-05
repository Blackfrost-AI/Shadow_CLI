#!/usr/bin/env python3
"""Exercise a built CLI in a real POSIX PTY; no provider requests or external tool execution.
Usage: python3 scripts/smoke-snowfall-pty.py node dist/index.js
       python3 scripts/smoke-snowfall-pty.py ./dist-bin/shadow
Uses the caller's normal configuration, with provider=mock, offline and dry-run CLI overrides.
Never run against an account that still needs plaintext credential migration.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def exercise(command, ending):
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
    output = bytearray()
    with tempfile.TemporaryDirectory(prefix='shadow-snowfall-pty-') as workspace:
        env = dict(os.environ, TERM='xterm-256color', SHADOW_TUI='pi', SHADOW_NO_IMAGE_OPEN='1')
        argv = command + ['--provider', 'mock', '--model', 'mock-1', '--offline', '--dry-run', '--reduced-motion', '--workspace', workspace]
        process = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)

        def read_for(seconds):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                ready, _, _ = select.select([master], [], [], min(0.1, max(0, end - time.monotonic())))
                if ready:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)

        def expect(text, seconds=12):
            end = time.monotonic() + seconds
            def present():
                plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)
                return text in output or text in plain
            while not present() and time.monotonic() < end and process.poll() is None:
                read_for(0.1)
            check(present(), f'{ending}: missing {text!r}; process={process.poll()}')

        try:
            expect(b'\x1b[?1049h')
            expect(b'SHADOW')
            # A real bracketed paste must remain a draft until Enter.
            os.write(master, b'\x1b[200~PTY cafe \xe6\xbc\xa2\xe5\xad\x97\nsecond line\x1b[201~')
            read_for(0.2)
            check(b'I received' not in output, 'paste submitted before Enter')
            os.write(master, b'\r')
            expect(b'I received')
            for columns, rows in [(80, 24), (28, 8), (200, 40), (120, 36)]:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
                os.kill(process.pid, signal.SIGWINCH)
                read_for(0.2)
                check(process.poll() is None, f'crashed at {columns}x{rows}')
            os.write(master, b'/version\r')
            read_for(0.3)
            if ending == 'quit':
                os.write(master, b'/quit\r')
            elif ending == 'Ctrl+C':
                os.write(master, b'\x03')
                read_for(0.1)
                os.write(master, b'\x03')
            else:
                os.kill(process.pid, signal.SIGTERM)
            deadline = time.monotonic() + 8
            while process.poll() is None and time.monotonic() < deadline:
                read_for(0.1)
            check(process.poll() is not None, 'exit did not complete')
            read_for(0.1)
            check(b'\x1b[?1049l' in output, 'alternate buffer was not restored')
            check(b'\x1b[?1006l' in output, 'mouse mode was not disabled')
            check(b'\x1b[?25h' in output, 'cursor was not restored')
            check(b'\x1b[?2004l' in output, 'bracketed paste was not disabled')
            check(b'\x1b[?7h' in output, 'autowrap was not restored')
            check(b'\x1b[23;2t' in output, 'title was not restored')
            after = termios.tcgetattr(slave)
            check(before == after, 'terminal attributes were not restored')
            if ending in ('quit', 'Ctrl+C'):
                check(process.returncode == 0, f'quit exit status {process.returncode}')
            else:
                check(process.returncode in (-signal.SIGTERM, 128 + signal.SIGTERM), f'signal exit status lost: {process.returncode}')
            return {'ending': ending, 'passed': True, 'bytes': len(output), 'exit': process.returncode}
        finally:
            if os.environ.get('SHADOW_PTY_LOG'):
                Path(os.environ['SHADOW_PTY_LOG'] + '-' + ending + '.ansi').write_bytes(output)
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    check(len(sys.argv) > 1, 'provide a built CLI command')
    # An interactive launch can migrate this file. This harness must not trigger that workflow.
    check(not (Path.home() / '.shadow/credentials.json').exists(), 'refusing a CLI smoke with unmigrated credentials')
    command = sys.argv[1:]
    print(json.dumps({'platform': sys.platform, 'command': command, 'checks': [exercise(command, ending) for ending in ['quit', 'Ctrl+C', 'SIGTERM']]}, indent=2))
