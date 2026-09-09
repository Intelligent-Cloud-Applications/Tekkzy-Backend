const RESERVED_SUBDOMAINS = new Set([
  "www",
  "www1",
  "api",
  "admin",
  "app",
  "mail",
  "ftp",
  "smtp",
  "pop",
  "imap",
  "staging",
  "stage",
  "beta",
  "dev",
  "test",
  "demo",
  "cdn",
  "static",
  "assets",
  "media",
  "img",
  "images",
  "ns1",
  "ns2",
  "dns",
  "tekkzy",
  "happyprancer",
  "support",
  "help",
  "status",
  "dashboard",
  "login",
  "signup",
  "auth",
  "oauth",
  "billing",
  "payment",
  "payments",
  "checkout",
  "webhook",
  "webhooks",
  "root",
  "null",
  "undefined",
]);

const normalizeLabel = (value = "") =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.$/, "");

/**
 * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
 */
const validateSubdomainName = (raw) => {
  const name = normalizeLabel(raw).split(".")[0];

  if (!name) {
    return { ok: false, reason: "Subdomain name is required." };
  }

  if (name.length < 3) {
    return { ok: false, reason: "Subdomain must be at least 3 characters." };
  }

  if (name.length > 63) {
    return { ok: false, reason: "Subdomain must be 63 characters or fewer." };
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return {
      ok: false,
      reason: "Use only lowercase letters, numbers, and hyphens.",
    };
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    return {
      ok: false,
      reason: "Subdomain cannot start or end with a hyphen.",
    };
  }

  if (RESERVED_SUBDOMAINS.has(name)) {
    return { ok: false, reason: "This subdomain name is reserved." };
  }

  return { ok: true, name };
};

/**
 * @returns {{ ok: true, domain: string } | { ok: false, reason: string }}
 */
const validateCustomDomain = (raw) => {
  const original = String(raw || "").trim();

  if (!original) {
    return { ok: false, reason: "Domain is required." };
  }

  if (/\s/.test(original) || /:\/\//.test(original)) {
    return {
      ok: false,
      reason: "Enter a domain like mybrand.com (no spaces or https://).",
    };
  }

  let domain = normalizeLabel(original);

  // Strip accidental www. for storage consistency
  if (domain.startsWith("www.")) {
    domain = domain.slice(4);
  }

  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain
    )
  ) {
    return { ok: false, reason: "Enter a valid domain like mybrand.com." };
  }

  if (!domain.includes(".")) {
    return { ok: false, reason: "Domain must include a TLD (e.g. .com)." };
  }

  return { ok: true, domain };
};

module.exports = {
  RESERVED_SUBDOMAINS,
  normalizeLabel,
  validateSubdomainName,
  validateCustomDomain,
};
