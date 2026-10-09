#!/usr/bin/env python3
"""Verify cancellation against a real stalled HTTP stream in a POSIX terminal.
Usage: python3 scripts/smoke-interrupt-pty.py node dist/index.js
       python3 scripts/smoke-interrupt-pty.py ./dist-bin/shadow
Uses a disposable profile, fake credentials, and an offline loopback provider.
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
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def exercise(command, label, key, partial, thinking=False):
    class Provider(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        requests = 0
        started = threading.Event()
        closed = threading.Event()

        def log_message(self, *_args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            Provider.requests += 1
            current = Provider.requests
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            if current > 1 or partial:
                text = 'FIRSTSTREAMSTARTED' if current == 1 else 'SECONDTURNCOMPLETED'
                field = 'reasoning_content' if thinking and current == 1 else 'content'
                event = {'choices': [{'index': 0, 'delta': {field: text}}]}
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
            Provider.started.set()
            if current > 1:
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
                return
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if select.select([self.connection], [], [], 0.05)[0]:
                    try:
                        closed = not self.connection.recv(1, socket.MSG_PEEK)
                    except ConnectionResetError:
                        closed = True
                    if closed:
                        Provider.closed.set()
                        return

    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
    output = bytearray()
    with tempfile.TemporaryDirectory(prefix='shadow-interrupt-pty-') as workspace:
        env = {k: v for k, v in os.environ.items() if not k.startswith(('SHADOW_', 'OPENAI_', 'ANTHROPIC_'))}
        env.update(HOME=workspace, USERPROFILE=workspace, TERM='xterm-256color', SHADOW_TUI='pi', OPENAI_API_KEY='fixture-key')
        argv = command + ['--provider', 'openai', '--model', 'fixture', '--base-url', f'http://127.0.0.1:{server.server_port}/v1', '--offline', '--dry-run', '--reduced-motion', '--workspace', workspace]
        process = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)

        def read_for(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.03)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)

        def wait_for(predicate, message, seconds=8):
            deadline = time.monotonic() + seconds
            while not predicate() and process.poll() is None and time.monotonic() < deadline:
                read_for(0.05)
            check(predicate(), f'{label}: {message}; exit={process.poll()}; tail={bytes(output[-1500:])!r}')

        def contains(text):
            return text in re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)

        try:
            wait_for(lambda: contains(b'SHADOW'), 'startup failed')
            os.write(master, b'Keep streaming\r')
            wait_for(Provider.started.is_set, 'provider did not receive the request')
            if partial:
                wait_for(lambda: contains(b'FIRSTSTREAMSTARTED'), 'first response was not rendered')
            if thinking:
                wait_for(lambda: contains(b'Thinking'), 'thinking panel was not rendered')
            started = time.monotonic()
            os.write(master, key)
            wait_for(Provider.closed.is_set, 'interrupt did not close the connection', 3)
            wait_for(lambda: contains(b'interrupted'), 'interrupt notice missing', 3)
            os.write(master, b'A new request\r')
            wait_for(lambda: contains(b'SECONDTURNCOMPLETED'), 'next turn stayed queued after interrupt', 3)
            elapsed = time.monotonic() - started
            check(Provider.requests == 2, 'interrupt retried the cancelled request')
            os.write(master, b'/quit\r')
            wait_for(lambda: process.poll() is not None, 'quit did not finish')
            read_for(0.1)
            check(process.returncode == 0, f'quit exited {process.returncode}')
            check(before == termios.tcgetattr(slave), 'terminal attributes were not restored')
            check(b'\x1b[?1049l' in output, 'alternate buffer was not restored')
            return {'case': label, 'passed': True, 'requests': Provider.requests, 'seconds': round(elapsed, 3)}
        finally:
            if os.environ.get('SHADOW_PTY_LOG'):
                Path(os.environ['SHADOW_PTY_LOG'] + '-' + label + '.ansi').write_bytes(output)
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            os.close(master)
            os.close(slave)
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    check(len(sys.argv) > 1, 'provide a built CLI command')
    cases = [('escape-streaming', b'\x1b', True), ('escape-first-token', b'\x1b', False), ('ctrl-c-streaming', b'\x03', True), ('escape-thinking', b'\x1b', True, True)]
    print(json.dumps({'platform': sys.platform, 'checks': [exercise(sys.argv[1:], *case) for case in cases]}, indent=2))
