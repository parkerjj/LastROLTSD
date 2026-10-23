export function isLocalDemoMode(location?: Pick<Location, 'hostname' | 'search'>): boolean {
  const current = location ?? (typeof window === 'undefined' ? null : window.location);
  if (!current) return false;
  const hostname = current.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return false;
  return new URLSearchParams(current.search).get('demo') === '1';
}
