const {
  Route53Client,
  ListResourceRecordSetsCommand,
} = require("@aws-sdk/client-route-53");
const { response } = require("../../../Utils/Functions");
const { validateSubdomainName } = require("../domain-payment/validators");
const { isDomainAvailableForClaim } = require("../domain-payment/domainClaims");
const { ROOT_DOMAIN } = require("../domain-payment/pricingConfig");

const route53 = new Route53Client({ region: "us-east-1" });
const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID;

/* Simple per-container rate limit (best-effort on Lambda) */
const hits = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const allowRequest = (key) => {
  const now = Date.now();
  const entry = hits.get(key) || { count: 0, start: now };
  if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
    hits.set(key, { count: 1, start: now });
    return true;
  }
  entry.count += 1;
  hits.set(key, entry);
  return entry.count <= RATE_LIMIT_MAX;
};

module.exports.main = async (event) => {
  try {
    const identity =
      event?.requestContext?.identity?.cognitoIdentityId ||
      event?.requestContext?.identity?.sourceIp ||
      "anon";

    if (!allowRequest(String(identity))) {
      return response(429, {
        success: false,
        available: false,
        reason: "Too many availability checks. Please wait a moment.",
      });
    }

    const { subdomain, domain } = event.queryStringParameters || {};
    const rootDomain = (domain || ROOT_DOMAIN).toLowerCase().trim();

    if (!subdomain) {
      return response(400, {
        success: false,
        available: false,
        reason: "subdomain is required",
      });
    }

    const validated = validateSubdomainName(subdomain);
    if (!validated.ok) {
      return response(200, {
        success: true,
        available: false,
        reason: validated.reason,
        subdomain: null,
        domain: rootDomain,
      });
    }

    const normalizedSub = validated.name;
    const fullDomain = `${normalizedSub}.${rootDomain}`;

    let dnsAvailable = true;
    if (HOSTED_ZONE_ID) {
      const result = await route53.send(
        new ListResourceRecordSetsCommand({
          HostedZoneId: HOSTED_ZONE_ID,
          StartRecordName: fullDomain,
          MaxItems: "5",
        })
      );

      dnsAvailable = !(result.ResourceRecordSets || []).some((record) => {
        const name = String(record.Name || "")
          .replace(/\.$/, "")
          .toLowerCase();
        return (
          name === fullDomain.toLowerCase() &&
          ["A", "AAAA", "CNAME"].includes(record.Type)
        );
      });
    }

    if (!dnsAvailable) {
      return response(200, {
        success: true,
        subdomain: normalizedSub,
        domain: rootDomain,
        fullDomain,
        available: false,
        reason: "This subdomain is already taken.",
      });
    }

    const cognitoId = event?.requestContext?.identity?.cognitoIdentityId;
    const claim = await isDomainAvailableForClaim(
      fullDomain,
      cognitoId || "__none__",
      "__none__"
    );

    if (!claim.available) {
      return response(200, {
        success: true,
        subdomain: normalizedSub,
        domain: rootDomain,
        fullDomain,
        available: false,
        reason: claim.reason || "This subdomain is already taken.",
      });
    }

    return response(200, {
      success: true,
      subdomain: normalizedSub,
      domain: rootDomain,
      fullDomain,
      available: true,
    });
  } catch (err) {
    console.error("Subdomain check error:", err);
    return response(500, {
      success: false,
      available: false,
      reason: "Unable to check availability right now.",
      error: err.message,
    });
  }
};
