#!/usr/bin/env python3
"""Real terminal onboarding against a disposable loopback provider and isolated profile.
Usage: python3 scripts/smoke-onboard-pty.py node dist/index.js
       python3 scripts/smoke-onboard-pty.py ./dist-bin/shadow
No cloud requests, real credentials, model downloads, or real profile writes.
"""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
import threading
import time


def check(value, message):
    if not value:
        raise RuntimeError(message)


class Provider(BaseHTTPRequestHandler):
    attempts = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        body = json.dumps({'data': [{'id': 'fixture-one'}, {'id': 'fixture-two'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        Provider.attempts += 1
        if Provider.attempts == 1:
            body = b'{"error":{"message":"temporary fixture failure"}}'
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
        else:
            body = b'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def exercise(command, ending, port):
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
    output = bytearray()
    with tempfile.TemporaryDirectory(prefix='shadow-onboard-pty-') as profile:
        env = dict(os.environ, HOME=profile, USERPROFILE=profile, TERM='xterm-256color')
        for key in list(env):
            if key.startswith(('SHADOW_', 'OPENAI_', 'ANTHROPIC_')):
                env.pop(key)
        proc = subprocess.Popen(command + ['onboard'], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)

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

        def expect(text, offset=0, seconds=12):
            end = time.monotonic() + seconds
            def present():
                plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output[offset:])
                return text in plain
            while not present() and time.monotonic() < end and proc.poll() is None:
                read_for(0.1)
            check(present(), f'{ending}: missing {text!r}; process={proc.poll()}; tail={bytes(output[-2000:])!r}')

        def send(data):
            offset = len(output)
            os.write(master, data)
            return offset

        try:
            expect(b'How do you want to run Shadow?')
            send(b'\r')  # Default: model server.
            expect(b'Choose a model server')
            send(b'7\r')  # Custom endpoint.
            expect(b'Endpoint URL')
            send(f'\x1b[200~http://127.0.0.1:{port}/v1\x1b[201~'.encode())
            read_for(0.15)
            send(b'\r')
            expect(b'API key')
            send(b'\x1b[200~fixture-secret-onboard\x1b[201~')
            read_for(0.15)
            check(b'fixture-secret-onboard' not in output, 'secret was echoed')
            if ending == 'save':
                send(b'\r')
                expect(b'Choose models')
                for columns, rows in [(80, 24), (28, 8), (200, 40), (120, 36)]:
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
                    os.kill(proc.pid, signal.SIGWINCH)
                    read_for(0.15)
                    check(proc.poll() is None, f'exited at {columns}x{rows}')
                send(b' \x1b[B \r')
                expect(b'Default model')
                send(b'\x1b[B\r')
                expect(b'Connection needs attention')
                send(b'\r')  # Retry.
                expect(b'Review and save')
                send(b'\r')
                expect(b'Saved Custom endpoint')
            elif ending == 'Ctrl+C':
                send(b'\x03')
            else:
                os.kill(proc.pid, signal.SIGTERM)
            end = time.monotonic() + 5
            while proc.poll() is None and time.monotonic() < end:
                read_for(0.1)
            check(proc.poll() is not None, 'process did not exit promptly (leftover timeout/input handle)')
            read_for(0.1)
            check(before == termios.tcgetattr(slave), 'terminal attributes not restored')
            for sequence in [b'\x1b[?1049l', b'\x1b[?25h', b'\x1b[?2004l', b'\x1b[23;2t']:
                check(sequence in output, f'missing restore sequence {sequence!r}')
            config_path = Path(profile) / '.shadow/config.json'
            if ending == 'save':
                check(proc.returncode == 0, f'exit {proc.returncode}')
                config = json.loads(config_path.read_text())
                check(config['model'] == 'fixture-two', 'wrong default model')
                check(len(config['models']) == 2, 'multi-selection lost')
                creds = json.loads((Path(profile) / '.shadow/credentials.json').read_text())
                for model in config['models']:
                    check(creds[model['credRef']]['apiKey'] == 'fixture-secret-onboard', 'key was not saved for this endpoint')
            else:
                check(not config_path.exists(), 'cancellation saved a partial setup')
            check(b'fixture-secret-onboard' not in output, 'secret appeared in scrollback')
            return {'ending': ending, 'passed': True, 'exit': proc.returncode}
        finally:
            if os.environ.get('SHADOW_PTY_LOG'):
                Path(os.environ['SHADOW_PTY_LOG'] + '-onboard-' + ending + '.ansi').write_bytes(output)
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    check(len(sys.argv) > 1, 'provide a CLI command')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        checks = [exercise(sys.argv[1:], ending, server.server_port) for ending in ['save', 'Ctrl+C', 'SIGTERM']]
        # A pipe may deliver every answer in one chunk. No reader swap may discard later lines.
        with tempfile.TemporaryDirectory(prefix='shadow-onboard-pipe-') as profile:
            env = dict(os.environ, HOME=profile, USERPROFILE=profile, TERM='dumb')
            for key in list(env):
                if key.startswith(('SHADOW_', 'OPENAI_', 'ANTHROPIC_')):
                    env.pop(key)
            Provider.attempts = 0
            answers = f'2\n7\nhttp://127.0.0.1:{server.server_port}/v1\nfixture-secret-onboard\n1,2\n2\n1\n1\n'
            result = subprocess.run(sys.argv[1:] + ['onboard'], input=answers, capture_output=True, text=True, env=env, timeout=8)
            check(result.returncode == 0 and 'Saved Custom endpoint' in result.stdout, 'piped onboarding did not complete')
            check('fixture-secret-onboard' not in result.stdout + result.stderr, 'piped secret was echoed')
            config = json.loads((Path(profile) / '.shadow/config.json').read_text())
            check(config['model'] == 'fixture-two', 'piped default was not saved')
            checks.append({'ending': 'piped answers', 'passed': True, 'exit': result.returncode})
        print(json.dumps({'command': sys.argv[1:], 'checks': checks}, indent=2))
    finally:
        server.shutdown()
        server.server_close()
