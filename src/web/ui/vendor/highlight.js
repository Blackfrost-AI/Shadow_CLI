/**
 * Tiny, dependency-free syntax highlighter for the chat canvas's fenced code
 * blocks. Not a full grammar — a single-pass tokenizer that classifies strings,
 * comments, numbers, and a broad cross-language keyword set. Good enough to make
 * code read like the reference client without pulling in highlight.js; unknown languages
 * still get strings/numbers/comments. Pure + synchronous so it's trivially tested.
 */
// Union of keywords/literals across the languages chat models emit most. A few
// false positives (a keyword used as an identifier) are an acceptable trade for
// staying grammar-free.
const KEYWORDS = new Set([
    // JS/TS
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
    'case', 'break', 'continue', 'class', 'extends', 'new', 'this', 'super', 'import', 'export',
    'from', 'as', 'default', 'async', 'await', 'yield', 'try', 'catch', 'finally', 'throw',
    'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'type', 'interface', 'enum', 'implements',
    'public', 'private', 'protected', 'static', 'readonly', 'abstract', 'namespace', 'declare',
    // literals
    'true', 'false', 'null', 'undefined', 'NaN', 'None', 'True', 'False',
    // Python
    'def', 'lambda', 'elif', 'pass', 'with', 'and', 'or', 'not', 'is', 'global', 'nonlocal',
    'raise', 'except', 'finally', 'assert', 'del', 'self',
    // Go / Rust / C-family
    'func', 'fn', 'struct', 'impl', 'pub', 'use', 'mod', 'package', 'defer', 'go', 'chan',
    'map', 'range', 'select', 'match', 'let', 'mut', 'trait', 'where', 'unsafe', 'int', 'string',
    'bool', 'float', 'double', 'char', 'long', 'short', 'unsigned', 'sizeof',
]);
const HASH_COMMENT_LANGS = new Set([
    'py', 'python', 'sh', 'bash', 'zsh', 'shell', 'rb', 'ruby', 'yaml', 'yml', 'toml',
    'r', 'perl', 'pl', 'makefile', 'make', 'dockerfile', 'ini', 'conf',
]);
/** Tokenize `code` into colored spans. `lang` selects the line-comment style. */
export function highlight(code, lang = '') {
    const hash = HASH_COMMENT_LANGS.has(lang.toLowerCase());
    const lineComment = hash ? '#[^\\n]*' : '\\/\\/[^\\n]*';
    const re = new RegExp([
        '(\\/\\*[\\s\\S]*?\\*\\/)', // 1: block comment
        `(${lineComment})`, // 2: line comment
        '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)', // 3: string
        '(\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)', // 4: number
        '([A-Za-z_$][A-Za-z0-9_$]*)', // 5: identifier
    ].join('|'), 'g');
    const spans = [];
    let last = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
        if (m.index > last)
            spans.push({ text: code.slice(last, m.index), role: 'plain' });
        if (m[1] || m[2])
            spans.push({ text: m[0], role: 'comment' });
        else if (m[3])
            spans.push({ text: m[0], role: 'string' });
        else if (m[4])
            spans.push({ text: m[0], role: 'number' });
        else
            spans.push({ text: m[0], role: KEYWORDS.has(m[0]) ? 'keyword' : 'plain' });
        last = re.lastIndex;
        if (re.lastIndex === m.index)
            re.lastIndex++; // guard against any zero-width match
    }
    if (last < code.length)
        spans.push({ text: code.slice(last), role: 'plain' });
    return spans;
}
