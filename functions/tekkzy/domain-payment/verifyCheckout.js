const crypto = require("crypto");
const Razorpay = require("razorpay");
const {
  GetCommand,
  UpdateCommand,
  PutCommand,
  dynamoDB,
} = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const {
  getPlan,
  normalizeDomainType,
  normalizeBillingCycle,
  computeRenewDate,
  INSTITUTION,
  ROOT_DOMAIN,
} = require("./pricingConfig");
const { updateClaimStatus } = require("./domainClaims");
const { validateSubdomainName, validateCustomDomain } = require("./validators");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_TEST_KEY_ID,
  key_secret: process.env.RAZORPAY_TEST_SECRET_KEY,
});

const parseBody = (event) => {
  if (!event?.body) return {};
  return typeof event.body === "string"
    ? JSON.parse(event.body || "{}")
    : event.body;
};

const markSucceeded = async ({
  cognitoId,
  paymentId,
  siteId,
  domainType,
  domainName,
  fullDomain,
  billingCycle,
  plan,
  razorpay_payment_id,
  razorpay_subscription_id,
  renewDate,
  currentPeriodEnd,
}) => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  await dynamoDB.send(
    new UpdateCommand({
      TableName: process.env.PAYMENT_TABLE_NAME,
      Key: { cognitoId: String(cognitoId), paymentId: String(paymentId) },
      UpdateExpression:
        "SET #status = :status, isVerified = :verified, paidAt = :paidAt, razorpayPaymentId = :rpay, renewDate = :renew, amountPaid = :amount, updatedAt = :updatedAt, productPurchased = :product, domainType = :domainType, domainName = :domainName, fullDomain = :fullDomain, billingCycle = :billingCycle",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "succeeded",
        ":verified": true,
        ":paidAt": now,
        ":rpay": String(razorpay_payment_id),
        ":renew": renewDate,
        ":amount": Number(plan.amount),
        ":updatedAt": now,
        ":product": plan.productPurchased,
        ":domainType": domainType,
        ":domainName": domainName,
        ":fullDomain": fullDomain,
        ":billingCycle": billingCycle,
      },
    })
  );

  await dynamoDB.send(
    new UpdateCommand({
      TableName: process.env.PROFILE_TABLE_NAME,
      Key: { institution: INSTITUTION, cognitoId: String(cognitoId) },
      UpdateExpression:
        "SET subscription_status = :subStatus, product_purchased = :product, domain_name = :domainName, domain_type = :domainType, billing_cycle = :billingCycle, plan_renewal_date = :renew, domain_status = :domainStatus, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":subStatus": "active",
        ":product": plan.productPurchased,
        ":domainName": fullDomain,
        ":domainType": domainType,
        ":billingCycle": billingCycle,
        ":renew": renewDate,
        ":domainStatus": "provisioning",
        ":updatedAt": nowIso,
      },
    })
  );

  await dynamoDB.send(
    new UpdateCommand({
      TableName: process.env.SITE_TABLE,
      Key: { userId: String(cognitoId), siteId: String(siteId) },
      UpdateExpression:
        "SET requestedDomain = :domain, domain = :domain, domainType = :domainType, billingCycle = :billingCycle, domainStatus = :domainStatus, productPurchased = :product, planRenewalDate = :renew, subscriptionStatus = :subStatus, razorpaySubscriptionId = :subId, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":domain": fullDomain,
        ":domainType": domainType,
        ":billingCycle": billingCycle,
        ":domainStatus": "provisioning",
        ":product": plan.productPurchased,
        ":renew": renewDate,
        ":subStatus": "active",
        ":subId": String(razorpay_subscription_id || paymentId),
        ":updatedAt": nowIso,
      },
    })
  );

  await updateClaimStatus(fullDomain, "active", {
    ownerCognitoId: String(cognitoId),
    siteId: String(siteId),
    graceEndsAt: null,
  });

  return { now, renewDate, currentPeriodEnd };
};

module.exports.main = async (event) => {
  try {
    const cognitoId = event?.requestContext?.identity?.cognitoIdentityId;
    if (!cognitoId) {
      return response(401, {
        success: false,
        message: "Please sign in to continue.",
      });
    }

    const body = parseBody(event);
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
      siteId,
      domainType: rawDomainType,
      domainName: rawDomainName,
      billingCycle: rawBillingCycle,
    } = body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return response(400, {
        success: false,
        message: "Payment confirmation details are missing. Please try again.",
      });
    }

    if (!siteId) {
      return response(400, {
        success: false,
        message: "siteId is required.",
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_TEST_SECRET_KEY)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.error("Invalid Razorpay signature for domain checkout verify");
      return response(400, {
        success: false,
        message: "Payment could not be verified. Please contact support if you were charged.",
      });
    }

    const paymentId = String(razorpay_subscription_id);
    const existingPayment = await dynamoDB.send(
      new GetCommand({
        TableName: process.env.PAYMENT_TABLE_NAME,
        Key: { cognitoId: String(cognitoId), paymentId },
      })
    );

    if (
      existingPayment.Item &&
      ["succeeded", "SUCCESS"].includes(String(existingPayment.Item.status))
    ) {
      return response(200, {
        success: true,
        alreadyProcessed: true,
        domainStatus: "provisioning",
        fullDomain: existingPayment.Item.fullDomain,
        planRenewalDate: existingPayment.Item.renewDate,
        productPurchased: existingPayment.Item.productPurchased,
      });
    }

    const domainType = normalizeDomainType(
      rawDomainType || existingPayment.Item?.domainType
    );
    const billingCycle = normalizeBillingCycle(
      rawBillingCycle || existingPayment.Item?.billingCycle
    );
    const plan = getPlan(domainType, billingCycle);
    if (!plan || !domainType || !billingCycle) {
      return response(400, {
        success: false,
        message: "Invalid plan details for this payment.",
      });
    }

    let domainName = String(
      rawDomainName || existingPayment.Item?.domainName || ""
    ).trim();
    let fullDomain = existingPayment.Item?.fullDomain;

    if (domainType === "subdomain") {
      const validated = validateSubdomainName(domainName);
      if (!validated.ok) {
        return response(400, { success: false, message: validated.reason });
      }
      domainName = validated.name;
      fullDomain = `${domainName}.${ROOT_DOMAIN}`;
    } else {
      const validated = validateCustomDomain(domainName);
      if (!validated.ok) {
        return response(400, { success: false, message: validated.reason });
      }
      domainName = validated.domain;
      fullDomain = validated.domain;
    }

    const siteRes = await dynamoDB.send(
      new GetCommand({
        TableName: process.env.SITE_TABLE,
        Key: { userId: cognitoId, siteId: String(siteId) },
      })
    );
    if (!siteRes.Item) {
      return response(403, {
        success: false,
        message: "You do not have access to this site.",
      });
    }

    let renewDate = computeRenewDate(Date.now(), billingCycle);
    let currentPeriodEnd = null;

    try {
      const subscription = await razorpay.subscriptions.fetch(
        razorpay_subscription_id
      );
      if (subscription?.current_end) {
        currentPeriodEnd = Number(subscription.current_end) * 1000;
        renewDate = currentPeriodEnd;
      }
    } catch (fetchErr) {
      console.warn("Could not fetch subscription period end", fetchErr.message);
    }

    if (!existingPayment.Item) {
      await dynamoDB.send(
        new PutCommand({
          TableName: process.env.PAYMENT_TABLE_NAME,
          Item: {
            cognitoId: String(cognitoId),
            paymentId,
            amount: Number(plan.amount),
            currency: plan.currency,
            institution: INSTITUTION,
            siteId: String(siteId),
            domainType,
            domainName,
            fullDomain,
            billingCycle,
            productPurchased: plan.productPurchased,
            paymentMode: "Razorpay",
            razorpaySubscriptionId: String(razorpay_subscription_id),
            razorpayPaymentId: String(razorpay_payment_id),
            status: "pending",
            isVerified: false,
            createdAt: Date.now(),
            flow: "tekkzy-domain-deploy",
          },
        })
      );
    }

    await markSucceeded({
      cognitoId,
      paymentId,
      siteId,
      domainType,
      domainName,
      fullDomain,
      billingCycle,
      plan,
      razorpay_payment_id,
      razorpay_subscription_id,
      renewDate,
      currentPeriodEnd,
    });

    return response(200, {
      success: true,
      verified: true,
      domainStatus: "provisioning",
      fullDomain,
      domainType,
      billingCycle,
      productPurchased: plan.productPurchased,
      planRenewalDate: renewDate,
      subscriptionId: razorpay_subscription_id,
      paymentId: razorpay_payment_id,
      message:
        "Payment confirmed. We are provisioning your domain — this can take a few minutes.",
    });
  } catch (err) {
    console.error("verifyCheckout error", err);
    return response(500, {
      success: false,
      message: "Payment verification failed. Please try again or contact support.",
      error: err.message,
    });
  }
};
