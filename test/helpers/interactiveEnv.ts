// These tests supply a real VT buffer and TTY-like streams. Ink otherwise suppresses
// interactive frames when CI=true, so establish the fixture before importing Ink.
process.env.CI = 'false';
