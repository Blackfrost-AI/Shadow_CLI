#!/usr/bin/env python3
"""Exercise a built Shadow against native Codex in a disposable tmux server.
Usage: python3 scripts/smoke-tmux-pty.py ./dist-bin/shadow
Requires local tmux and Codex with --no-daemon. No model request or real profile is used.
"""
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
import struct
import subprocess
import sys
import tempfile
import termios
import time


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    check(len(sys.argv) > 1, 'provide a built Shadow command')
    codex = shutil.which('codex')
    check(codex and shutil.which('tmux'), 'Codex and tmux must already be installed')
    codex = str(Path(codex).resolve())
    command = [str(Path(sys.argv[1]).resolve()), *sys.argv[2:]]
    with tempfile.TemporaryDirectory(prefix='shadow-tmux-smoke-', dir='/tmp') as directory:
        root = Path(directory)
        socket = str(root / 'server.sock')
        home = root / 'home'
        home.mkdir()
        codex_home = root / 'codex'
        codex_home.mkdir()
        workspace = root / 'workspace'
        workspace.mkdir()
        (codex_home / 'config.toml').write_text('''model = "fixture"
model_provider = "fixture"
[model_providers.fixture]
name = "Local UI fixture"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
''')

        def tmux(*args):
            return subprocess.check_output(['tmux', '-S', socket, *args], text=True, timeout=5)

        agent = shlex.join(['env', 'HOME=' + str(home), 'CODEX_HOME=' + str(codex_home), codex,
                           '--no-daemon', '--no-alt-screen', '-C', str(workspace),
                           '--sandbox', 'read-only', '--ask-for-approval', 'on-request'])
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'codex-fixture', '-x', '100', '-y', '30', agent)
        process = None
        master = slave = None
        try:
            deadline = time.monotonic() + 10
            while 'Ask Codex' not in tmux('capture-pane', '-p', '-t', 'codex-fixture'):
                check(time.monotonic() < deadline, 'isolated Codex failed to start')
                time.sleep(.1)
            agent_pid = tmux('display-message', '-p', '-t', 'codex-fixture', '#{pane_pid}').strip()
            master, slave = pty.openpty()
            before = termios.tcgetattr(slave)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
            env = {k: v for k, v in os.environ.items() if not k.startswith(('SHADOW_', 'OPENAI_', 'ANTHROPIC_', 'CODEX_'))}
            env.update(HOME=str(home), USERPROFILE=str(home), CODEX_HOME=str(codex_home),
                       TERM='xterm-256color', SHADOW_TUI='pi', TMUX=socket + ',0,0', OPENAI_API_KEY='fixture-key')
            process = subprocess.Popen(command + ['--provider', 'openai', '--model', 'fixture', '--base-url', 'http://127.0.0.1:1/v1',
                '--offline', '--dry-run', '--reduced-motion', '--workspace', str(workspace)],
                stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
            output = bytearray()

            def read_for(seconds):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    if select.select([master], [], [], .03)[0]:
                        try:
                            chunk = os.read(master, 65536)
                        except OSError:
                            break
                        if not chunk:
                            break
                        output.extend(chunk)

            def contains(text):
                return text in re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)

            def wait_for(predicate, label):
                deadline = time.monotonic() + 8
                while not predicate() and process.poll() is None and time.monotonic() < deadline:
                    read_for(.05)
                check(predicate(), label + '; terminal tail=' + repr(bytes(output[-1000:])))

            def send(text):
                os.write(master, text.encode())
                read_for(.08)
                os.write(master, b'\r')

            wait_for(lambda: contains(b'SHADOW'), 'Shadow startup failed')
            os.write(master, b'/tmux ')
            wait_for(lambda: contains(b'codex-fixture'), 'live session completion missing')
            os.write(master, b'\r')
            wait_for(lambda: contains(b'Esc detach'), 'selection did not connect')
            send('/status')
            wait_for(lambda: contains(b'Model provider:'), 'Codex did not receive /status')
            check('0 total' in tmux('capture-pane', '-p', '-J', '-S', '-', '-t', 'codex-fixture'), 'unexpected model usage')
            send('/permissions')
            wait_for(lambda: contains(b'Update Model Permissions'), 'native Codex menu missing')
            os.write(master, b'\x1bOQ')
            wait_for(lambda: contains(b'DIRECT KEYS'), 'direct key mode missing')
            os.write(master, b'\x1b[A')
            read_for(.1)
            os.write(master, b'\x1b')
            read_for(.3)
            check('Update Model Permissions' not in tmux('capture-pane', '-p', '-t', 'codex-fixture'), 'Escape did not close the Codex menu')
            os.write(master, b'\x1d')
            read_for(.2)
            send('/quit')
            wait_for(lambda: process.poll() is not None, 'Shadow did not exit')
            check(process.returncode == 0, 'Shadow exit failed')
            check(before == termios.tcgetattr(slave), 'terminal attributes were not restored')
            check(agent_pid == tmux('display-message', '-p', '-t', 'codex-fixture', '#{pane_pid}').strip(), 'agent process changed')
            check(tmux('display-message', '-p', '-t', 'codex-fixture', '#{pane_current_command}').strip() == 'codex', 'detaching stopped Codex')
            print(json.dumps({'passed': True, 'checks': ['live autocomplete', 'single-Enter connect',
                'native Codex status', 'native Codex menu and Escape', 'detach preserves agent',
                'terminal restoration', 'zero model tokens']}, indent=2))
        finally:
            if process and process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            if master is not None:
                os.close(master)
                os.close(slave)
            # The uniquely named socket belongs only to this disposable test.
            subprocess.run(['tmux', '-S', socket, 'kill-server'], capture_output=True, timeout=5)


if __name__ == '__main__':
    main()
