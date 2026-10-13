import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { TmuxClient, parseTmuxPanes, isCodexPane } from '../src/tmux/client.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';

test('tmux inventory preserves names and stable IDs, rejects malformed rows, and recognizes Codex', () => {
  const panes = parseTmuxPanes('$0\tcraig-main\twork\t0\t%0\t0\tcodex\t101\t1\n$1\tmargo main\twork\t0\t%1\t0\tzsh\t202\t1\nmalformed\n');
  assert.equal(panes.length, 2);
  assert.equal(panes[1]!.session, 'margo main');
  assert.equal(isCodexPane(panes[0]!), true);
  assert.equal(isCodexPane(panes[1]!), false);
  assert.equal(isCodexPane({ ...panes[0]!, command: 'not-codex' }), false);
});

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
test('real isolated tmux: history, literal multiline input, direct keys, and stale-pane protection',
  { skip: !hasTmux || !hasPython || process.platform === 'win32' }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'shadow-tmux-test-'));
    const socket = join(root, 'server.sock');
    const input = join(root, 'input.bin');
    const program = join(root, 'terminal.py');
    const ready = join(root, 'ready');
    writeFileSync(program, `import os,sys,tty\nfrom pathlib import Path\ntty.setraw(sys.stdin.fileno())\nfor i in range(160): os.write(1, ('history-%03d\\r\\n' % i).encode())\nos.write(1,b'\\x1b[?2004h')\nPath(${JSON.stringify(ready)}).touch()\nwhile True:\n data=os.read(0,4096)\n if not data: break\n with open(${JSON.stringify(input)},'ab') as f: f.write(data)\n`);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const tmux = (args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '90', '-y', '24', `python3 ${quote(program)}`]);
    t.after(async () => {
      // This socket was created exclusively by this test. Never address the user's server.
      spawnSync('tmux', ['-S', socket, 'kill-server']);
      await removeFixtureTree(root);
    });
    const until = async (fn: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(fn());
    };
    await until(() => existsSync(ready));
    // Label only this inert raw terminal fixture as Codex; all commands still run against
    // real tmux, including bracketed paste, byte delivery, buffers and process identity.
    const shim = join(root, 'tmux-fixture');
    writeFileSync(shim, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const fs=require('node:fs');\nconst a=process.argv.slice(2);const r=spawnSync('tmux',a,{input:a.includes('load-buffer')?fs.readFileSync(0):undefined,encoding:'utf8'});\nlet out=r.stdout||'';if(a.includes('list-panes')||a.includes('display-message'))out=out.split('\\n').map(l=>{let f=l.split('\\t');if(f.length===9)f[6]='codex';return f.join('\\t')}).join('\\n');process.stdout.write(out);process.stderr.write(r.stderr||'');process.exit(r.status??1);\n`, { mode: 0o755 });
    const client = new TmuxClient({ socket, executable: shim });
    const [pane] = await client.list(); assert.ok(pane);
    assert.match(await client.capture(pane), /history-000/);
    assert.match(await client.capture(pane), /history-159/);
    const first = 'hello café 漢字\n$(not-a-command); quoted "text"';
    await Promise.all([client.send(pane, first), client.send(pane, 'second')]);
    await client.keys(pane, '\x1b[A');
    const expected = `\x1b[200~${first}\x1b[201~\r\x1b[200~second\x1b[201~\r\x1b[A`;
    await until(() => existsSync(input) && readFileSync(input, 'utf8').length >= expected.length);
    assert.equal(readFileSync(input, 'utf8'), expected);
    assert.equal(tmux(['list-buffers']).trim(), '', 'bridge buffers are removed without changing the clipboard');
    tmux(['copy-mode', '-t', pane.id]);
    await assert.rejects(client.send(pane, 'do not paste into copy mode'), /copy mode is open/);
    await client.keys(pane, 'q');
    assert.equal(tmux(['display-message', '-p', '-t', pane.id, '#{pane_in_mode}']).trim(), '0');
    await assert.rejects(client.send({ ...pane, pid: pane.pid + 1 }, 'wrong target'), /changed or closed/);
    await assert.rejects(client.send(pane, 'unsafe\x1btext'), /control characters/);
    const plain = new TmuxClient({ socket });
    const [actual] = await plain.list(); assert.ok(actual);
    await assert.rejects(plain.send(actual, 'must not reach a non-Codex process'), /Codex is no longer/);
    assert.equal(readFileSync(input, 'utf8'), expected);
  });
