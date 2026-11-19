/** Match the SDK's per-attempt auth_time check with World IdP's device-flow freshness control. */
export function freshWorldDeviceFlow(issuer: string, rawFetch: typeof fetch = globalThis.fetch): typeof fetch {
  const origin = new URL(issuer).origin;
  return async (input, init) => {
    let request = new Request(input, init);
    if (request.method === 'POST' && new URL(request.url).origin === origin && request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(await request.clone().text());
      if (form.get('scope') === 'openid' && !form.has('grant_type')) {
        form.set('max_age', '0');
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        request = new Request(request, { headers, body: form.toString() });
      }
    }
    return rawFetch(request);
  };
}
