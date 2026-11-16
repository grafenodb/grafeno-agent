import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Where a model server is, as far as the agent can tell from its address:
 * - `local`: this computer (loopback);
 * - `network`: a machine on the person's own network (a private address);
 * - `remote`: anywhere else (a self-hosted server on the internet).
 */
export type Locality = "local" | "network" | "remote";

export type EndpointCheck =
  | { readonly ok: true; readonly url: string; readonly locality: Locality; readonly host: string }
  | { readonly ok: false; readonly reason: string };

const strip = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();

/** Addresses never reached: link-local ones, where clouds keep their metadata services. */
function forbiddenAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.includes(":")) {
    // fe80::/10 link-local; fd00:ec2::254 (a cloud metadata address); IPv4 mapped ones are checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return forbiddenAddress(mapped[1]);
    return /^fe[89ab]/.test(lower) || lower === "fd00:ec2::254";
  }
  const [a = -1, b = -1] = lower.split(".").map(Number);
  // 169.254.0.0/16 link-local (169.254.169.254: cloud metadata); 0.0.0.0/8 "this network".
  return (a === 169 && b === 254) || a === 0;
}

function loopbackAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return loopbackAddress(mapped[1]);
    return lower === "::1";
  }
  return lower.startsWith("127.");
}

function privateAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return privateAddress(mapped[1]);
    return /^f[cd]/.test(lower);
  }
  const [a = -1, b = -1] = lower.split(".").map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Where an address is: this computer, the person's network, or anywhere. */
export function localityOfAddress(ip: string): Locality {
  if (loopbackAddress(ip)) return "local";
  if (privateAddress(ip)) return "network";
  return "remote";
}

/** Names that are this computer, or a private network's. */
function localityOfName(host: string): Locality | undefined {
  if (host === "localhost" || host.endsWith(".localhost")) return "local";
  if (/\.(local|lan|home\.arpa|internal|intranet|corp)$/.test(host) || !host.includes(".")) {
    return "network";
  }
  return undefined;
}

/**
 * Checks a model server's address before anything is sent to it: http or
 * https only, no credentials, query or fragment in it, never a link-local
 * address (where clouds answer with their machines' secrets) nor
 * `0.0.0.0`; and says where it is. A key is never sent in the clear to
 * another machine: with `withKey`, a server off this computer needs https.
 */
export function checkEndpoint(raw: string, options: { withKey?: boolean } = {}): EndpointCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "it is not a URL (such as http://localhost:11434)" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http and https addresses are used" };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "a URL with a user or password in it is not used: give the key on its own",
    };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "the address takes no query (?…) nor fragment (#…)" };
  }
  const host = strip(url.hostname);
  if (host === "" || host === "0.0.0.0" || host === "::") {
    return {
      ok: false,
      reason: "0.0.0.0 is where a server listens, not an address to reach: use 127.0.0.1",
    };
  }
  if (isIP(host) !== 0 && forbiddenAddress(host)) {
    return { ok: false, reason: "link-local addresses (169.254.x.x, fe80::) are never reached" };
  }
  if (/^metadata(\.|$)/.test(host)) {
    return { ok: false, reason: "a cloud's metadata service is never reached" };
  }
  const locality = isIP(host) !== 0 ? localityOfAddress(host) : (localityOfName(host) ?? "remote");
  if (options.withKey === true && locality !== "local" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: "a key is never sent in the clear to another machine: use the server's https address",
    };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.protocol}//${url.host}${path}`, locality, host };
}

/**
 * Where the server's name really leads, once resolved: a name that resolves
 * to a link-local address is refused; one that resolves to this computer or
 * a private address is that, whatever its name says.
 */
export async function resolveEndpoint(
  check: Extract<EndpointCheck, { ok: true }>,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((a) => a.address),
): Promise<EndpointCheck> {
  if (isIP(check.host) !== 0) return check;
  let addresses: string[];
  try {
    addresses = await resolve(check.host);
  } catch {
    // Not resolvable now: the request will say so; nothing is learned of it.
    return check;
  }
  if (addresses.some(forbiddenAddress)) {
    return { ok: false, reason: `${check.host} leads to a link-local address: never reached` };
  }
  const order: Locality[] = ["local", "network", "remote"];
  // The widest of where it leads: a name that also leads outside is remote.
  const widest = addresses
    .map(localityOfAddress)
    .reduce<Locality>(
      (a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a),
      addresses.length > 0 ? "local" : check.locality,
    );
  return { ...check, locality: widest };
}

/** Where a server is, in words. */
export function localityText(locality: Locality): string {
  switch (locality) {
    case "local":
      return "on this computer";
    case "network":
      return "on your network";
    default:
      return "self-hosted, outside your network";
  }
}
