import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiContext, RouteFn } from '../router.js';
import {
  listPlugins,
  removePlugin,
  setPluginEnabled,
  type PluginInfo,
} from '../../plugins/manager.js';

/**
 * Plugin management. Plugins are DATA-ONLY markdown bundles; installation stays a CLI action
 * (`shadow plugin add <path|url>`) because it can clone or copy into ~/.shadow. The host exposes
 * listing, enable/disable and archive-removal only. Enabled plugin directories are consumed when a
 * session is built, so changes apply to new sessions (the UI says so).
 *
 * The response intentionally omits `dir` and source paths: those are host filesystem details.
 */

function view(info: PluginInfo) {
  return {
    name: info.name,
    version: info.manifest.version,
    description: info.manifest.description,
    ...(info.manifest.author ? { author: info.manifest.author } : {}),
    enabled: info.meta.enabled,
    counts: info.counts,
    source: info.meta.source.kind,
  };
}

export function registerPluginRoutes(route: RouteFn, _ctx: ApiContext): void {
  route('GET', /^\/api\/plugins$/, () => ({
    status: 200,
    body: { plugins: listPlugins().map(view) },
  }));

  route('POST', /^\/api\/plugins\/([^/]+)\/(enable|disable)$/, (_req, _res, m) => {
    const name = decodeURIComponent(m[1] ?? '');
    const enabled = m[2] === 'enable';
    try {
      const info = setPluginEnabled(name, enabled);
      return { status: 200, body: { plugin: view(info) } };
    } catch (error) {
      return { status: 404, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  });

  route('DELETE', /^\/api\/plugins\/([^/]+)$/, (_req, _res, m) => {
    const name = decodeURIComponent(m[1] ?? '');
    try {
      removePlugin(name);
      return { status: 200, body: { name, removed: true, archived: true } };
    } catch (error) {
      return { status: 404, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  });
}