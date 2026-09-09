const {
  Route53DomainsClient,
  CheckDomainAvailabilityCommand,
  GetDomainSuggestionsCommand,
  ListPricesCommand,
} = require("@aws-sdk/client-route-53-domains");

const { response } = require("../../../Utils/Functions");

const client = new Route53DomainsClient({
  region: "us-east-1",
});

const MARKUP_USD = Number(process.env.DOMAIN_MARKUP_USD || 5);
const USD_TO_INR = Number(process.env.USD_TO_INR_RATE || 86);

const COMMON_ALT_TLDS = [
  "net",
  "org",
  "io",
  "co",
  "app",
  "dev",
  "ai",
  "in",
  "info",
  "xyz",
];

const parseDomainParts = (domain) => {
  const normalized = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  const parts = normalized.split(".").filter(Boolean);
  if (parts.length < 2) {
    return { domain: normalized, sld: normalized, tld: "" };
  }

  const tld = parts[parts.length - 1];
  const sld = parts.slice(0, -1).join(".");
  return { domain: normalized, sld, tld };
};

const roundInr = (value) => Math.round(Number(value) || 0);

const buildCustomerPrice = (awsPriceUsd) => {
  const aws = Number(awsPriceUsd);
  if (!Number.isFinite(aws) || aws < 0) {
    return null;
  }

  const markupUsd = MARKUP_USD;
  const totalUsd = aws + markupUsd;
  const totalInr = roundInr(totalUsd * USD_TO_INR);

  return {
    currency: "INR",
    period: "year",
    awsPriceUsd: Number(aws.toFixed(2)),
    markupUsd,
    totalUsd: Number(totalUsd.toFixed(2)),
    amountInr: totalInr,
    usdToInrRate: USD_TO_INR,
    label: "per year",
  };
};

const priceCache = new Map();

const getTldRegistrationPriceUsd = async (tld) => {
  const clean = String(tld || "")
    .replace(/^\./, "")
    .toLowerCase();
  if (!clean) return null;

  if (priceCache.has(clean)) {
    return priceCache.get(clean);
  }

  try {
    const result = await client.send(
      new ListPricesCommand({
        Tld: `.${clean}`,
        MaxItems: 1,
      }),
    );

    const registration = result?.Prices?.[0]?.RegistrationPrice;
    const price = registration?.Price;
    const value = Number.isFinite(Number(price)) ? Number(price) : null;
    priceCache.set(clean, value);
    return value;
  } catch (err) {
    try {
      const result = await client.send(
        new ListPricesCommand({
          Tld: clean,
          MaxItems: 1,
        }),
      );
      const registration = result?.Prices?.[0]?.RegistrationPrice;
      const price = registration?.Price;
      const value = Number.isFinite(Number(price)) ? Number(price) : null;
      priceCache.set(clean, value);
      return value;
    } catch (innerErr) {
      console.warn(`ListPrices failed for .${clean}:`, innerErr.message || err.message);
      priceCache.set(clean, null);
      return null;
    }
  }
};

const withPricing = async (domainName) => {
  const { domain, tld } = parseDomainParts(domainName);
  const awsPriceUsd = await getTldRegistrationPriceUsd(tld);
  const pricing = buildCustomerPrice(awsPriceUsd);

  return {
    domain,
    tld,
    available: true,
    pricing,
  };
};

const isAvailableStatus = (availability) =>
  String(availability || "").toUpperCase() === "AVAILABLE";

const fetchAwsSuggestions = async (domain) => {
  try {
    const result = await client.send(
      new GetDomainSuggestionsCommand({
        DomainName: domain,
        SuggestionCount: 15,
        OnlyAvailable: true,
      }),
    );

    return (result?.SuggestionsList || [])
      .map((item) => item?.DomainName)
      .filter(Boolean)
      .filter((name) => name.toLowerCase() !== domain.toLowerCase());
  } catch (err) {
    console.warn("GetDomainSuggestions failed:", err.message);
    return [];
  }
};

const fetchTldAlternatives = async (sld, primaryTld) => {
  const candidates = COMMON_ALT_TLDS.filter((tld) => tld !== primaryTld).map(
    (tld) => `${sld}.${tld}`,
  );

  const checks = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const result = await client.send(
          new CheckDomainAvailabilityCommand({ DomainName: candidate }),
        );
        if (isAvailableStatus(result.Availability)) {
          return candidate;
        }
      } catch {
        // skip unsupported / failed TLD checks
      }
      return null;
    }),
  );

  return checks.filter(Boolean);
};

module.exports.main = async (event) => {
  try {
    const { domain: rawDomain } = event.queryStringParameters || {};

    if (!rawDomain) {
      return response(400, {
        success: false,
        message: "domain required",
      });
    }

    const { domain, sld, tld } = parseDomainParts(rawDomain);

    if (!tld || !sld) {
      return response(400, {
        success: false,
        message: "Enter a full domain like mybrand.com",
      });
    }

    const result = await client.send(
      new CheckDomainAvailabilityCommand({
        DomainName: domain,
      }),
    );

    const availability = result.Availability;
    const available = isAvailableStatus(availability);
    const awsPriceUsd = await getTldRegistrationPriceUsd(tld);
    const pricing = buildCustomerPrice(awsPriceUsd);

    let alternatives = [];

    if (!available) {
      const suggestions = await fetchAwsSuggestions(domain);
      let tldAlts = [];

      if (suggestions.length < 5) {
        tldAlts = await fetchTldAlternatives(sld, tld);
      }

      const unique = Array.from(new Set([...suggestions, ...tldAlts])).slice(
        0,
        12,
      );

      alternatives = await Promise.all(unique.map((name) => withPricing(name)));
    }

    return response(200, {
      success: true,
      domain,
      availability,
      available,
      pricing,
      markupUsd: MARKUP_USD,
      usdToInrRate: USD_TO_INR,
      alternatives,
    });
  } catch (err) {
    console.error("checkDomainAvailability error:", err);
    return response(500, {
      success: false,
      error: err.message,
    });
  }
};
