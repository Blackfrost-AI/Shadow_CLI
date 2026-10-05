import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function shellFixture(script: string): string {
  if (process.platform !== 'win32') return script;
  const bash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  if (!existsSync(bash)) throw new Error('Git Bash is required for the POSIX hook fixtures on Windows');
  const wrapper = script + '.cmd';
  writeFileSync(wrapper, `@"${bash}" --noprofile --norc "${script.replaceAll('\\', '/')}"\r\n@exit /b %errorlevel%\r\n`);
  return wrapper;
}
