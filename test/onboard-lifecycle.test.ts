import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('terminal setup stays alive after discovery even when the input backend has no referenced handle', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-onboard-lifetime-'));
  try {
    const script = `
      const {TerminalOnboardUI}=await import('./src/onboard/ui.ts');
      const {HeadlessTerminal}=await import('./test/helpers/snowfallTerminal.ts');
      const terminal=new HeadlessTerminal(80,25);
      const ui=new TerminalOnboardUI(terminal);
      try {
        const models=await ui.busy({stage:2,title:'Discover models'},async()=>['glm-5.3-derisked']);
        const selected=ui.choose({stage:2,title:'Choose models'},models.map(id=>({id,label:id})),{multiple:true,search:true});
        // Model a console backend whose input handle no longer keeps the event loop alive.
        // This timer must NOT be the thing keeping the process alive while the user thinks.
        setTimeout(()=>terminal.input('\\r'),500).unref();
        const answer=await selected;
        if(answer[0]!=='glm-5.3-derisked')throw new Error('model selection was lost');
        console.log('selected after discovery');
      } finally {ui.close();terminal.screen.dispose();}
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '-e', script],
      { cwd: process.cwd(), env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 5000 },
    );
    assert.match(result.stdout, /selected after discovery/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
