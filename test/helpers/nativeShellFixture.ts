/** Small byte-exact fixtures for the actual shell selected by run_shell. */
function quote(value: string): string {
  return `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
}

export function printFixture(value: string): string {
  return process.platform === 'win32' ? `[Console]::Write(${quote(value)})` : `printf '%s' ${quote(value)}`;
}

export function writeFixture(path: string, value: string): string {
  return process.platform === 'win32'
    ? `[System.IO.File]::WriteAllText(${quote(path)}, ${quote(value)})`
    : `printf '%s' ${quote(value)} > ${quote(path)}`;
}
