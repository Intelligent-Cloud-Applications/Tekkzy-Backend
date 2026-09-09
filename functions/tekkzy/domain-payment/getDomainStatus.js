const { GetCommand, dynamoDB } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const { INSTITUTION, GRACE_DAYS } = require("./pricingConfig");

module.exports.main = async (event) => {
  try {
    const cognitoId = event?.requestContext?.identity?.cognitoIdentityId;
    if (!cognitoId) {
      return response(401, {
        success: false,
        message: "Please sign in to continue.",
      });
    }

    const siteId = String(
      event?.queryStringParameters?.siteId || ""
    ).trim();

    if (!siteId) {
      return response(400, {
        success: false,
        message: "siteId is required.",
      });
    }

    const siteRes = await dynamoDB.send(
      new GetCommand({
        TableName: process.env.SITE_TABLE,
        Key: { userId: cognitoId, siteId },
      })
    );

    if (!siteRes.Item) {
      return response(403, {
        success: false,
        message: "You do not have access to this site.",
      });
    }

    const site = siteRes.Item;

    let profile = null;
    try {
      const profileRes = await dynamoDB.send(
        new GetCommand({
          TableName: process.env.PROFILE_TABLE_NAME,
          Key: { institution: INSTITUTION, cognitoId },
        })
      );
      profile = profileRes.Item || null;
    } catch (err) {
      console.warn("profile fetch failed", err.message);
    }

    const domainStatus =
      site.domainStatus ||
      profile?.domain_status ||
      (site.status === "LIVE" ? "active" : "pending");

    return response(200, {
      success: true,
      siteId,
      domainStatus,
      domainName: site.domain || site.requestedDomain || profile?.domain_name || null,
      domainType: site.domainType || profile?.domain_type || null,
      billingCycle: site.billingCycle || profile?.billing_cycle || null,
      productPurchased:
        site.productPurchased || profile?.product_purchased || null,
      planRenewalDate:
        site.planRenewalDate || profile?.plan_renewal_date || null,
      subscriptionStatus:
        site.subscriptionStatus ||
        profile?.subscription_status ||
        "none",
      lastError: site.provisionLastError || null,
      graceDays: GRACE_DAYS,
      graceEndsAt: site.graceEndsAt || profile?.graceEndsAt || null,
      siteStatus: site.status || null,
    });
  } catch (err) {
    console.error("getDomainStatus error", err);
    return response(500, {
      success: false,
      message: "Unable to load domain status.",
      error: err.message,
    });
  }
};
