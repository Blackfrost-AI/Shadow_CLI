import { setEgressResolverForTests } from '../../src/safety/egress.js';

/**
 * Let brokered requests to FAKE hostnames reach a stubbed `globalThis.fetch`.
 *
 * Why this exists: `shadowFetch()` resolves a request's hostname BEFORE it hands the
 * request to the transport — the metadata-tier SSRF check fails closed when a name does
 * not resolve (that fail-closed behavior is deliberate; see the egress broker). Tests that
 * stub `globalThis.fetch` and point a provider/tool at a make-believe host
 * (`http://mock/…`, `http://vision.test/…`, `https://models.example.net/…`) therefore
 * never reach the stub: the broker denies the unresolvable name first.
 *
 * These tests exercise provider/vision/temperature logic, not egress policy, so install a
 * resolver that answers a harmless public TEST-NET-3 address for every name. The pre-connect
 * check then passes (the address is neither cloud-metadata nor treated specially), and the
 * stubbed fetch receives the request exactly as before the broker existed. IP literals and
 * `localhost` never consult the resolver, so they are unaffected.
 *
 * Returns a restore function — call it in the same `finally` that restores `globalThis.fetch`.
 */
export function resolveFakeHosts(): () => void {
  setEgressResolverForTests(() => Promise.resolve(['203.0.113.10']));
  return () => setEgressResolverForTests(null);
}
