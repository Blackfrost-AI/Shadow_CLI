/**
 * Minimal DOM helpers — avoids any framework while keeping view code readable. No virtual
 * DOM, no diffing: views rebuild their container's children from a snapshot of state and
 * re-attach listeners. For the list-heavy surfaces (sessions, models) this is fine because
 * updates are coarse (a CRUD op re-renders the table); streamed chat will use incremental
 * appends rather than full rebuilds.
 */

/**
 * URL schemes allowed on `href`/`src`. Anything else — `javascript:`, `data:`, `vbscript:` —
 * is dropped rather than rendered. This surface will eventually display model-authored and
 * repo-sourced content, where a link target is attacker-controlled input.
 */
const SAFE_URL = /^(?:https?:|mailto:|#|\/)/i;

/**
 * Build an element. This is the ONLY place the UI creates DOM, and it never parses HTML:
 * children are appended as text nodes or elements, so a string can never become markup. That
 * is the whole XSS story for this page — and it matters more than usual here, because an
 * injection on a page that can POST to /api/* is equivalent to code execution.
 *
 * Event handlers must be assigned as properties, not attributes. `setAttribute('onclick', fn)`
 * stringifies the function into an HTML attribute, where it evaluates in global scope with
 * none of its closure — so every handler passed this way was silently dead. That bug made all
 * nine per-row buttons (Set default / Enable / Disable / Delete / Edit) no-ops.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    // Absent/false attributes are omitted so callers can spread conditionals inline.
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node[k] = v;
    else if ((k === 'href' || k === 'src') && !SAFE_URL.test(String(v).trim())) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Clear and repopulate a container. */
export function mount(container, children) {
  container.replaceChildren(...children);
}
