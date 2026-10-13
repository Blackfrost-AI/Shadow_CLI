#!/usr/bin/env python3
"""Smoke the compiled feature menus in a disposable offline PTY.
Usage: python3 scripts/smoke-functionality-pty.py /path/to/shadow
       python3 scripts/smoke-functionality-pty.py node dist/index.js
No configured endpoint, real profile, or existing session is used.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


def main():
    if len(sys.argv) < 2:
        raise SystemExit('Usage: smoke-functionality-pty.py <binary|node> [script]')
    executable = shutil.which(sys.argv[1])
    if executable is None:
        raise SystemExit(f'Executable not found: {sys.argv[1]}')
    command = [executable, *sys.argv[2:]]
    with tempfile.TemporaryDirectory(prefix='shadow-features-pty-') as directory:
        root = Path(directory)
        (root / '.shadow').mkdir()
        (root / 'guide.txt').write_text('PRIVATE_LOCAL_CONTEXT_FIXTURE\n')
        (root / 'findings.json').write_text(json.dumps([{'title': 'Fixture finding', 'description': 'Local test only'}]))
        (root / '.shadow' / 'checks.json').write_text(json.dumps({'version': 1, 'profiles': [
            {'id': 'fixture', 'title': 'Fixture check', 'command': 'true'}]}))
        env = {key: value for key, value in os.environ.items() if not key.startswith(('SHADOW_', 'OPENAI_', 'ANTHROPIC_'))}
        env.update(HOME=directory, USERPROFILE=directory, TERM='xterm-256color', SHADOW_TUI='pi')
        master, slave = pty.openpty()
        before = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 130, 0, 0))
        process = subprocess.Popen(command + ['--provider', 'mock', '--model', 'fixture', '--base-url', 'http://127.0.0.1:1/v1', '--offline', '--dry-run',
                                             '--reduced-motion', '--workspace', directory],
                                   stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        output = bytearray()

        def read_for(seconds):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if select.select([master], [], [], .03)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    output.extend(data)

        def wait_text(text, offset=0):
            end = time.monotonic() + 10
            while time.monotonic() < end:
                read_for(.05)
                cleaned = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output[offset:])
                if text.encode() in cleaned:
                    return
                if process.poll() is not None:
                    break
            raise RuntimeError(f'Missing {text!r}; exit={process.poll()}; tail={bytes(output[-1800:])!r}')

        def slash(text, expected):
            offset = len(output)
            os.write(master, text.encode() + b'\r')
            wait_text(expected, offset)

        def escape():
            os.write(master, b'\x1b')
            read_for(.15)

        try:
            wait_text('SHADOW')
            slash('/context pin guide.txt', 'Context'); escape()
            slash('/checks', 'Fixture check'); escape()
            slash('/workflows repository-review {"scope":"guide.txt"}', 'Source SHA-256')
            escape(); escape(); escape()  # preview -> actions -> catalog -> composer
            slash('/sessions', 'Search sessions'); escape()
            slash('/findings import findings.json', 'Fixture finding'); escape()
            slash('/findings export', 'Report saved')
            reports = list((root / '.shadow' / 'security' / 'reports').glob('*.md'))
            if len(reports) != 1 or 'Fixture finding' not in reports[0].read_text():
                raise RuntimeError('Compiled evidence store did not produce the expected local report')
            slash('/extensions', 'MCP servers'); escape()
            slash('/model history', 'No capability result'); escape()
            os.write(master, b'/quit\r')
            end = time.monotonic() + 8
            while process.poll() is None and time.monotonic() < end:
                read_for(.05)
            if process.returncode != 0 or before != termios.tcgetattr(slave) or b'\x1b[?1049l' not in output:
                raise RuntimeError('Process or terminal did not shut down cleanly')
            print(json.dumps({'passed': True, 'offline': True, 'menus': ['context', 'checks', 'workflows', 'sessions', 'findings', 'extensions', 'model history'], 'reports': len(reports), 'terminalRestored': True}))
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    main()
