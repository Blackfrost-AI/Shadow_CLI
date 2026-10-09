#!/usr/bin/env python3
"""Exercise compiled native collaboration in a disposable POSIX terminal.

Usage: python3 scripts/smoke-parity-pty.py node dist/index.js
       python3 scripts/smoke-parity-pty.py ./dist-bin/shadow

Uses only the deterministic mock provider and a temporary Git workspace/profile.
Checks actual approval, native workers, durable jobs/messages, review/consultation
menus, terminal restoration and a consultation follow-up after process restart.
No production profile, credentials, external provider or user session is used.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
import time


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


class Terminal:
    def __init__(self, command, workspace, profile, session=None):
        self.master, self.slave = pty.openpty()
        self.before = termios.tcgetattr(self.slave)
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
        self.output = bytearray()
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('SHADOW_', 'OPENAI_', 'ANTHROPIC_', 'CODEX_', 'CLAUDE_'))}
        env.update(HOME=str(profile), USERPROFILE=str(profile), TERM='xterm-256color',
                   SHADOW_TUI='pi', SHADOW_NO_IMAGE_OPEN='1', SHADOW_ALLOW_IMPORT='0')
        args = (['resume', '--session', str(session)] if session else []) + [
            '--provider', 'mock', '--model', 'mock-1', '--base-url', 'http://127.0.0.1:1/v1',
            '--offline', '--reduced-motion', '--workspace', str(workspace)]
        self.process = subprocess.Popen(command + args, stdin=self.slave, stdout=self.slave,
                                        stderr=self.slave, env=env, start_new_session=True)
        try:
            self.expect(b'\x1b[?1049h')
            self.expect(b'SHADOW')
        except BaseException:
            self.close()
            raise

    def read_for(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], min(.05, max(0, deadline - time.monotonic())))
            if ready:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                self.output.extend(chunk)

    def send(self, data):
        marker = len(self.output)
        os.write(self.master, data.encode() if isinstance(data, str) else data)
        # A standalone Escape needs the terminal decoder's ambiguity window;
        # writing the next slash immediately would instead send Alt+/.
        if data == b'\x1b':
            self.read_for(.15)
        return marker

    def expect(self, text, since=0, seconds=10):
        def found():
            output = self.output[since:]
            plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)
            return text in output or text in plain
        self.until(found, repr(text), seconds)

    def until(self, predicate, label, seconds=10):
        deadline = time.monotonic() + seconds
        while not predicate() and self.process.poll() is None and time.monotonic() < deadline:
            self.read_for(.05)
        check(predicate(), f'Missing {label}; exit={self.process.poll()}; tail={bytes(self.output[-2400:])!r}')

    def resize(self, columns, rows):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)
        self.read_for(.15)
        check(self.process.poll() is None, f'crashed at {columns}x{rows}')

    def quit(self):
        self.send('/quit\r')
        self.until(lambda: self.process.poll() is not None, 'clean quit')
        self.read_for(.1)
        check(self.process.returncode == 0, f'quit status {self.process.returncode}')
        for marker in [b'\x1b[?1049l', b'\x1b[?1006l', b'\x1b[?25h', b'\x1b[?2004l', b'\x1b[?7h']:
            check(marker in self.output, f'terminal restoration missing {marker!r}')
        check(termios.tcgetattr(self.slave) == self.before, 'terminal attributes were not restored')

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        os.close(self.master)
        os.close(self.slave)


def jobs(workspace):
    path = workspace / '.shadow/jobs.sqlite'
    if not path.exists():
        return []
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        return [json.loads(row[0]) for row in db.execute('SELECT data FROM jobs')]


def consultations(workspace):
    latest = {}
    for path in sorted((workspace / '.shadow/sessions').glob('*.jsonl')):
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if row.get('kind') == 'consultation_snapshot':
                summary = row['data']['summary']
                latest[summary['id']] = (summary, path)
    return latest


def exercise(command):
    with tempfile.TemporaryDirectory(prefix='shadow-parity-pty-') as directory:
        root = Path(directory)
        workspace, profile = root / 'workspace', root / 'profile'
        workspace.mkdir(); (profile / '.shadow').mkdir(parents=True)
        (profile / '.shadow/config.json').write_text(json.dumps({
            'provider': 'mock', 'model': 'mock-1', 'autonomy': 'manual', 'notify': 'off',
            'instructionAutopilot': False, 'reducedMotion': True, 'models': [],
        }))
        def git(*args):
            return subprocess.check_output(['git', '-C', str(workspace), *args], stderr=subprocess.PIPE)
        git('init', '-q', '-b', 'fixture-main')
        git('config', 'user.name', 'Parity Fixture'); git('config', 'user.email', 'fixture@example.test')
        source = workspace / 'fixture.txt'
        source.write_text('before\n'); git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
        source.write_text('before\nafter\n')
        terminal = Terminal(command, workspace, profile)
        try:
            terminal.send('print ok\r'); terminal.read_for(.4)
            marker = terminal.send('/team second-opinion Cancel this approval fixture.\r')
            terminal.expect(b'requires confirmation', marker)
            terminal.read_for(.8)  # The production dialog intentionally rejects type-ahead.
            terminal.send(b'\x1b'); terminal.expect(b'denied by the user', marker)
            terminal.read_for(.2)
            check(not jobs(workspace), 'denied native action created a worker/job')
            marker = terminal.send('/autonomy auto-read\r'); terminal.expect(b'autonomy: auto-read', marker)
            marker = terminal.send('/team second-opinion Review the fixture without changing it.\r')
            terminal.until(lambda: any(job['status'] == 'completed' and job.get('category') == 'second-opinion'
                                       for job in jobs(workspace)), 'completed native workflow')
            terminal.expect(b'acceptance unverified', marker)
            recorded = jobs(workspace)
            workflow = next(job for job in recorded if job.get('category') == 'second-opinion')
            children = [job for job in recorded if job.get('parentId') == workflow['id']]
            check(len(children) == 1 and children[0]['status'] == 'completed', 'native reviewer did not finish its durable child job')
            check(children[0]['attempts'][0]['usage']['outputTokens'] > 0, 'native child usage was not persisted')

            marker = terminal.send('/jobs\r'); terminal.expect(b'Project jobs', marker)
            terminal.resize(80, 24); terminal.send(b'\x1b')
            marker = terminal.send('/room post project PARITY-PERSISTED-MESSAGE\r')
            terminal.expect(b'PARITY-PERSISTED-MESSAGE', marker); terminal.send(b'\x1b')
            marker = terminal.send('/review\r'); terminal.expect(b'Review scope', marker)
            terminal.send(b'\r'); terminal.expect(b'fixture.txt', marker)
            terminal.send(b'\r'); terminal.expect(b'+after', marker)
            terminal.send(b'\x1b'); terminal.send(b'\x1b')
            marker = terminal.send('/consult\r'); terminal.expect(b'Consult a model', marker)
            terminal.send(b'\x1b')
            marker = terminal.send('/consult current PARITY-CONSULTATION\r')
            terminal.until(lambda: any(item[0]['status'] == 'completed' for item in consultations(workspace).values()), 'persisted consultation')
            terminal.expect(b'/consult follow', marker)
            consultation_id, (summary, session) = next(iter(consultations(workspace).items()))
            check(summary['turns'] == 1, 'initial consultation turn count differs')
            check(source.read_text() == 'before\nafter\n', 'read-only native fixture modified source')
            terminal.quit()
        finally:
            terminal.close()

        resumed = Terminal(command, workspace, profile, session)
        try:
            marker = resumed.send('/jobs\r'); resumed.expect(b'Project jobs', marker)
            resumed.expect(b'second-opinion', marker); resumed.send(b'\x1b')
            marker = resumed.send('/room read project\r'); resumed.expect(b'PARITY-PERSISTED-MESSAGE', marker); resumed.send(b'\x1b')
            marker = resumed.send('/consult list\r'); resumed.expect(consultation_id.encode(), marker)
            marker = resumed.send(f'/consult follow {consultation_id} PARITY-FOLLOWUP\r')
            resumed.expect(b'requires confirmation', marker)
            resumed.read_for(.8)
            resumed.send('y')
            resumed.until(lambda: consultations(workspace).get(consultation_id, ({},))[0].get('turns') == 2
                          and consultations(workspace)[consultation_id][0]['status'] == 'completed', 'follow-up after restart')
            resumed.expect(b'PARITY-FOLLOWUP', marker)
            resumed.quit()
            return {'passed': True, 'backend': 'mock', 'workflow': workflow['status'],
                    'nativeChildJobs': len(children), 'consultationTurns': 2,
                    'approvalCancellation': True, 'resumedAgentApproval': True, 'persistentRoom': True,
                    'terminalRestored': True, 'sourceUnchanged': source.read_text() == 'before\nafter\n'}
        finally:
            resumed.close()


if __name__ == '__main__':
    check(len(sys.argv) > 1, 'provide a compiled CLI command')
    print(json.dumps({'platform': sys.platform, 'checks': exercise(sys.argv[1:])}, indent=2))
