/**
 * Address normalisation for the browser panel.
 *
 * Pure and dependency-free so it can be reasoned about — and tested — on its
 * own. What gets typed into a developer's address bar is usually not a URL:
 * it is a port number, a bare host, or a path.
 */

export interface NormalisedAddress {
  url: string | null;
  error?: string;
}

export function normaliseAddress(input: string): NormalisedAddress {
  const value = input.trim();
  if (!value) return { url: null };

  // A panel renders inside the app shell, so these schemes are a real hazard
  // rather than a theoretical one.
  if (/^(javascript|data|file|blob|vbscript):/i.test(value)) {
    return { url: null, error: "Only http and https addresses can be opened in a panel." };
  }

  // A bare port — by far the most common thing typed during development.
  if (/^\d{2,5}$/.test(value)) {
    const port = Number(value);
    if (port < 1 || port > 65535) return { url: null, error: "That is not a valid port." };
    return { url: `http://localhost:${port}` };
  }

  if (/^https?:\/\//i.test(value)) return { url: value };

  if (/^localhost(:\d+)?([/?#]|$)/i.test(value)) return { url: `http://${value}` };
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(value)) return { url: `http://${value}` };

  // A dotted hostname gets https; anything else is not an address.
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(value)) return { url: `https://${value}` };

  return { url: null, error: "That does not look like an address." };
}
