const Razorpay = require("razorpay");
const {
  GetCommand,
  PutCommand,
  UpdateCommand,
  dynamoDB,
} = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const {
  Route53Client,
  ListResourceRecordSetsCommand,
} = require("@aws-sdk/client-route-53");
const {
  getPlan,
  normalizeDomainType,
  normalizeBillingCycle,
  ROOT_DOMAIN,
  INSTITUTION,
} = require("./pricingConfig");
const {
  validateSubdomainName,
  validateCustomDomain,
} = require("./validators");
const { tryClaimDomain, isDomainAvailableForClaim } = require("./domainClaims");

const route53 = new Route53Client({ region: "us-east-1" });

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_TEST_KEY_ID,
  key_secret: process.env.RAZORPAY_TEST_SECRET_KEY,
});

const hasRazorpayConfig = () =>
  Boolean(process.env.RAZORPAY_TEST_KEY_ID && process.env.RAZORPAY_TEST_SECRET_KEY);

const parseBody = (event) => {
  if (!event?.body) return {};
  return typeof event.body === "string"
    ? JSON.parse(event.body || "{}")
    : event.body;
};

const checkRoute53Available = async (fullDomain) => {
  const hostedZoneId = process.env.HOSTED_ZONE_ID;
  if (!hostedZoneId) {
    return { available: true, skipped: true };
  }

  const result = await route53.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      StartRecordName: fullDomain,
      MaxItems: "5",
    })
  );

  const exists = (result.ResourceRecordSets || []).some((record) => {
    const name = String(record.Name || "")
      .replace(/\.$/, "")
      .toLowerCase();
    return name === fullDomain.toLowerCase() && ["A", "AAAA", "CNAME"].includes(record.Type);
  });

  return { available: !exists };
};

module.exports.main = async (event) => {
  try {
    if (!hasRazorpayConfig()) {
      return response(500, {
        success: false,
        message: "Payment is temporarily unavailable. Please try again later.",
      });
    }

    const cognitoId = event?.requestContext?.identity?.cognitoIdentityId;
    if (!cognitoId) {
      return response(401, {
        success: false,
        message: "Please sign in to continue.",
      });
    }

    const body = parseBody(event);
    const siteId = String(body.siteId || "").trim();
    const domainType = normalizeDomainType(body.domainType);
    const billingCycle = normalizeBillingCycle(body.billingCycle);
    const rawDomainName = String(body.domainName || "").trim();

    if (!siteId || !domainType || !billingCycle || !rawDomainName) {
      return response(400, {
        success: false,
        message:
          "siteId, domainType (subdomain|custom), domainName, and billingCycle (monthly|yearly) are required.",
      });
    }

    const plan = getPlan(domainType, billingCycle);
    if (!plan) {
      return response(400, {
        success: false,
        message: "Invalid plan selection.",
      });
    }

    /* Ownership: site must belong to this user */
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

    let domainName;
    let fullDomain;

    if (domainType === "subdomain") {
      const validated = validateSubdomainName(rawDomainName);
      if (!validated.ok) {
        return response(400, { success: false, message: validated.reason });
      }
      domainName = validated.name;
      fullDomain = `${domainName}.${ROOT_DOMAIN}`;
    } else {
      const validated = validateCustomDomain(rawDomainName);
      if (!validated.ok) {
        return response(400, { success: false, message: validated.reason });
      }
      domainName = validated.domain;
      fullDomain = validated.domain;
    }

    /* Re-check availability at checkout time */
    if (domainType === "subdomain") {
      const dns = await checkRoute53Available(fullDomain);
      if (!dns.available) {
        return response(409, {
          success: false,
          message: "This subdomain is no longer available.",
        });
      }
    }

    const claimCheck = await isDomainAvailableForClaim(
      fullDomain,
      cognitoId,
      siteId
    );
    if (!claimCheck.available) {
      return response(409, {
        success: false,
        message: claimCheck.reason || "This domain is no longer available.",
      });
    }

    const claim = await tryClaimDomain({
      fullDomain,
      cognitoId,
      siteId,
      domainType,
      billingCycle,
    });
    if (!claim.ok) {
      return response(409, {
        success: false,
        message: claim.reason || "This domain is no longer available.",
      });
    }

    const dynamicPlanId = plan.razorpayPlanId
      ? String(plan.razorpayPlanId)
      : (
          await razorpay.plans.create({
            period: plan.period,
            interval: Number(plan.interval || 1),
            item: {
              name: plan.name,
              amount: Number(plan.amount) * 100,
              currency: plan.currency,
              description: `${plan.productPurchased} for ${fullDomain}`,
            },
          })
        ).id;

    const subscription = await razorpay.subscriptions.create({
      plan_id: dynamicPlanId,
      customer_notify: 1,
      total_count: Number(plan.totalCount || 120),
      notes: {
        institution: INSTITUTION,
        siteId: String(siteId),
        cognitoId: String(cognitoId),
        domainType: String(domainType),
        domainName: String(domainName),
        fullDomain: String(fullDomain),
        billingCycle: String(billingCycle),
        productPurchased: String(plan.productPurchased),
        razorpayPlanId: String(dynamicPlanId),
        flow: "tekkzy-domain-deploy",
      },
    });

    const now = Date.now();
    const paymentItem = {
      cognitoId: String(cognitoId),
      paymentId: String(subscription.id),
      amount: Number(plan.amount),
      currency: plan.currency,
      active: true,
      institution: INSTITUTION,
      productId: String(siteId),
      siteId: String(siteId),
      planId: String(plan.productPurchased),
      productPurchased: String(plan.productPurchased),
      subscriptionType: "domain-deploy",
      domainType,
      domainName,
      fullDomain,
      billingCycle,
      paymentMode: "Razorpay",
      paymentDate: now,
      renewDate: null,
      emailId: "",
      isVerified: false,
      razorpayPlanId: String(dynamicPlanId),
      razorpaySubscriptionId: String(subscription.id),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      flow: "tekkzy-domain-deploy",
    };

    await dynamoDB.send(
      new PutCommand({
        TableName: process.env.PAYMENT_TABLE_NAME,
        Item: paymentItem,
      })
    );

    await dynamoDB.send(
      new UpdateCommand({
        TableName: process.env.SITE_TABLE,
        Key: { userId: cognitoId, siteId },
        UpdateExpression:
          "SET requestedDomain = :domain, domainType = :domainType, billingCycle = :billingCycle, domainStatus = :domainStatus, productPurchased = :product, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":domain": fullDomain,
          ":domainType": domainType,
          ":billingCycle": billingCycle,
          ":domainStatus": "pending",
          ":product": plan.productPurchased,
          ":updatedAt": new Date(now).toISOString(),
        },
      })
    );

    return response(200, {
      success: true,
      keyId: process.env.RAZORPAY_TEST_KEY_ID,
      subscriptionId: subscription.id,
      paymentId: paymentItem.paymentId,
      amount: plan.amount,
      currency: plan.currency,
      billingCycle,
      domainType,
      domainName,
      fullDomain,
      productPurchased: plan.productPurchased,
      planName: plan.name,
    });
  } catch (err) {
    console.error("createCheckout error", err);
    return response(500, {
      success: false,
      message: "Unable to start checkout. Please try again.",
      error: err.message,
    });
  }
};
