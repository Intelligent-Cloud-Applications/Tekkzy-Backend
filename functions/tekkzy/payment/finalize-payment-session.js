const crypto = require("crypto");
const axios = require("axios");
const Razorpay = require("razorpay");
const { PutCommand, UpdateCommand, dynamoDB } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const { PLAN_CATALOG } = require("./planCatalog");

const SITE_TABLE = process.env.SITE_TABLE;

const PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_TEST_KEY_ID,
  key_secret: process.env.RAZORPAY_TEST_SECRET_KEY,
});

const removeUndefinedDeep = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => removeUndefinedDeep(item))
      .filter((item) => typeof item !== "undefined");
  }

  if (value && typeof value === "object") {
    const cleaned = {};

    for (const [key, v] of Object.entries(value)) {
      const cleanedValue = removeUndefinedDeep(v);
      if (typeof cleanedValue !== "undefined") {
        cleaned[key] = cleanedValue;
      }
    }

    return cleaned;
  }

  return value;
};

const getCountryCodeFromRequest = (event, body) => {
  const bodyCountry = String(body?.countryCode || "").toUpperCase();
  if (bodyCountry) return bodyCountry;

  const headers = event?.headers || {};
  return String(
    headers["CloudFront-Viewer-Country"] || headers["cloudfront-viewer-country"] || ""
  ).toUpperCase();
};

const resolveBillingPeriod = (paymentType, planId) => {
  const periodFromCatalog = PLAN_CATALOG[paymentType]?.[planId]?.period;
  if (periodFromCatalog) {
    return periodFromCatalog;
  }

  const hint = `${paymentType || ""} ${planId || ""}`.toLowerCase();
  if (hint.includes("year") || hint.includes("domain")) {
    return "yearly";
  }

  return "monthly";
};

const computeRenewDate = (paymentDateEpoch, billingPeriod) => {
  const renewDate = new Date(paymentDateEpoch);
  if (billingPeriod === "yearly") {
    renewDate.setFullYear(renewDate.getFullYear() + 1);
  } else {
    renewDate.setMonth(renewDate.getMonth() + 1);
  }
  return renewDate.getTime();
};

const getExpectedPlan = (paymentType, planId, currency) => {
  const plan = PLAN_CATALOG[paymentType]?.[planId];
  if (!plan) return null;

  const amount = Number(plan.amountByCurrency?.[currency]);
  if (!amount) return null;

  return {
    amount,
    currency,
  };
};

const resolveDeployDomainType = (paymentType, metadata = {}) => {
  const fromMeta = String(metadata?.domainType || "").toLowerCase();
  if (fromMeta === "subdomain") return "subdomain";
  if (fromMeta === "custom" || fromMeta === "register") return "custom";
  if (String(paymentType || "").includes("domain")) return "custom";
  return "subdomain";
};

const resolveFullDomain = (metadata = {}, domainType) => {
  const display = String(metadata?.displayDomain || "").trim().toLowerCase();
  if (display) return display.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  const raw = String(metadata?.domain || "").trim().toLowerCase();
  if (!raw) return null;
  if (domainType === "subdomain") {
    return raw.includes(".") ? raw : `${raw}.tekkzy.com`;
  }
  return raw;
};

const markSiteAwaitingDeploy = async ({
  cognitoId,
  siteId,
  paymentType,
  planId,
  metadata,
  renewDate,
  paymentId,
}) => {
  if (!SITE_TABLE || !siteId) return;

  const domainType = resolveDeployDomainType(paymentType, metadata);
  const fullDomain = resolveFullDomain(metadata || {}, domainType);
  const billingCycle = String(
    metadata?.billingCycle || resolveBillingPeriod(paymentType, planId),
  ).toLowerCase();
  const nowIso = new Date().toISOString();
  const deployType =
    domainType === "subdomain"
      ? "subdomain"
      : metadata?.domainType === "connect"
        ? "connect"
        : "register";

  const values = {
    ":domainStatus": "awaiting_deploy",
    ":paymentStatus": "paid",
    ":subStatus": "active",
    ":product": String(planId),
    ":billingCycle": billingCycle,
    ":domainType": domainType,
    ":deployType": deployType,
    ":paymentId": String(paymentId),
    ":renew": renewDate || null,
    ":updatedAt": nowIso,
  };

  let updateExpression =
    "SET domainStatus = :domainStatus, paymentStatus = :paymentStatus, subscriptionStatus = :subStatus, productPurchased = :product, billingCycle = :billingCycle, domainType = :domainType, deployType = :deployType, lastPaymentId = :paymentId, planRenewalDate = :renew, updatedAt = :updatedAt";

  const params = {
    TableName: SITE_TABLE,
    Key: { userId: String(cognitoId), siteId: String(siteId) },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: values,
  };

  if (fullDomain) {
    params.UpdateExpression += ", requestedDomain = :domain, #domain = :domain";
    params.ExpressionAttributeValues[":domain"] = fullDomain;
    params.ExpressionAttributeNames = { "#domain": "domain" };
  }

  if (metadata?.contact) {
    params.UpdateExpression += ", deployContact = :contact";
    params.ExpressionAttributeValues[":contact"] = removeUndefinedDeep(metadata.contact);
  }

  await dynamoDB.send(new UpdateCommand(params));
};

const getPayPalCredentials = () => {
  const clientId = process.env.AWSAIAPP_PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.AWSAIAPP_PAYPAL_SECRET || process.env.PAYPAL_SECRET;

  return { clientId, secret };
};

const getPayPalAccessToken = async (clientId, secret) => {
  const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");

  const tokenRes = await axios.post(
    `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return tokenRes?.data?.access_token;
};

module.exports.main = async (event) => {
  try {
    const cognitoId = event?.requestContext?.identity?.cognitoIdentityId;
    if (!cognitoId) {
      return response(401, {
        success: false,
        message: "Unauthorized: cognitoId not found in request context",
      });
    }

    const body =
      typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};

    const {
      provider,
      siteId,
      planId,
      paymentType,
      customer,
      metadata,
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId,
    } = body;

    if (!provider || !siteId || !planId || !paymentType) {
      return response(400, {
        success: false,
        message: "provider, siteId, planId, paymentType required",
      });
    }

    const normalizedProvider = String(provider || "").toUpperCase();
    const countryCode = getCountryCodeFromRequest(event, body);

    if (normalizedProvider === "RAZORPAY") {
      if (!razorpay_payment_id || !razorpay_signature) {
        return response(400, {
          success: false,
          message: "razorpay_payment_id and razorpay_signature required",
        });
      }

      const verificationPayload = razorpay_subscription_id
        ? `${razorpay_payment_id}|${razorpay_subscription_id}`
        : `${razorpay_order_id}|${razorpay_payment_id}`;

      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_TEST_SECRET_KEY)
        .update(verificationPayload)
        .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        return response(400, {
          success: false,
          message: "Invalid payment signature",
        });
      }

      const expectedPlan = getExpectedPlan(paymentType, planId, "INR");
      if (!expectedPlan) {
        return response(400, {
          success: false,
          message: "Invalid paymentType or planId",
        });
      }

      const paymentDateEpoch = Date.now();
      const now = new Date(paymentDateEpoch).toISOString();
      const billingPeriod = resolveBillingPeriod(paymentType, planId);
      const renewDate = computeRenewDate(paymentDateEpoch, billingPeriod);
      const safeCustomer = customer ? removeUndefinedDeep(customer) : null;
      const safeMetadata = metadata ? removeUndefinedDeep(metadata) : null;
      const transactionId = `rzp_${razorpay_payment_id}`;

      const paymentId = String(razorpay_subscription_id || razorpay_payment_id);
      await dynamoDB.send(
        new PutCommand({
          TableName: process.env.PAYMENT_TABLE_NAME,
          Item: {
            cognitoId: String(cognitoId),
            paymentId,
            amount: Number(expectedPlan.amount),
            currency: "INR",
            active: true,
            institution: "tekkzy",
            productId: String(siteId),
            planId: String(planId),
            subscriptionType: String(paymentType),
            billingPeriod,
            paymentMode: "Razorpay",
            paymentDate: paymentDateEpoch,
            renewDate,
            isVerified: true,
            siteId: String(siteId),
            razorpayOrderId: razorpay_order_id || null,
            razorpaySubscriptionId: razorpay_subscription_id || null,
            razorpayPaymentId: razorpay_payment_id || null,
            transactionId,
            status: "SUCCESS",
            verifiedAt: now,
            countryCode: countryCode || null,
            customer: safeCustomer,
            metadata: safeMetadata,
          },
        })
      );

      await markSiteAwaitingDeploy({
        cognitoId,
        siteId,
        paymentType,
        planId,
        metadata: safeMetadata,
        renewDate,
        paymentId,
      });

      return response(200, {
        success: true,
        verified: true,
        provider: "RAZORPAY",
        transactionId,
        subscriptionId: razorpay_subscription_id || null,
        domainStatus: "awaiting_deploy",
      });
    }

    if (normalizedProvider !== "PAYPAL") {
      return response(400, {
        success: false,
        message: "Unsupported provider",
      });
    }

    if (!orderId) {
      return response(400, {
        success: false,
        message: "orderId required for PayPal",
      });
    }

    const { clientId, secret } = getPayPalCredentials();
    if (!clientId || !secret) {
      return response(500, {
        success: false,
        message: "PayPal credentials are not configured",
      });
    }

    const accessToken = await getPayPalAccessToken(clientId, secret);

    const captureRes = await axios.post(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const captureData = captureRes?.data;
    if (captureData?.status !== "COMPLETED") {
      return response(400, {
        success: false,
        message: "PayPal capture is not completed",
        captureStatus: captureData?.status,
      });
    }

    const capturedPurchaseUnit = captureData?.purchase_units?.[0];
    const capturedInfo = capturedPurchaseUnit?.payments?.captures?.[0];
    const capturedAmount = Number(capturedInfo?.amount?.value || 0);
    const capturedCurrency = String(capturedInfo?.amount?.currency_code || "").toUpperCase();

    const expectedPlan = getExpectedPlan(paymentType, planId, "USD");
    if (!expectedPlan) {
      return response(400, {
        success: false,
        message: "Invalid paymentType or planId",
      });
    }

    if (
      capturedCurrency !== "USD" ||
      Number(capturedAmount.toFixed(2)) !== Number(expectedPlan.amount.toFixed(2))
    ) {
      return response(400, {
        success: false,
        message: "Captured payment does not match expected plan amount",
        expected: {
          amount: expectedPlan.amount,
          currency: "USD",
        },
        actual: {
          amount: capturedAmount,
          currency: capturedCurrency,
        },
      });
    }

    const paymentDateEpoch = Date.now();
    const now = new Date(paymentDateEpoch).toISOString();
    const billingPeriod = resolveBillingPeriod(paymentType, planId);
    const renewDate = computeRenewDate(paymentDateEpoch, billingPeriod);
    const safeCustomer = customer ? removeUndefinedDeep(customer) : null;
    const safeMetadata = metadata ? removeUndefinedDeep(metadata) : null;
    const transactionId = capturedInfo?.id || `paypal_${orderId}`;

    await dynamoDB.send(
      new PutCommand({
        TableName: process.env.PAYMENT_TABLE_NAME,
        Item: {
          cognitoId: String(cognitoId),
          paymentId: String(orderId),
          amount: Number(expectedPlan.amount),
          currency: "USD",
          active: true,
          institution: "tekkzy",
          productId: String(siteId),
          planId: String(planId),
          subscriptionType: String(paymentType),
          billingPeriod,
          paymentMode: "PayPal",
          paymentDate: paymentDateEpoch,
          renewDate,
          isVerified: true,
          siteId: String(siteId),
          paypalOrderId: String(orderId),
          paypalCaptureId: String(transactionId),
          transactionId: String(transactionId),
          status: "SUCCESS",
          verifiedAt: now,
          countryCode: countryCode || null,
          customer: safeCustomer,
          metadata: safeMetadata,
        },
      })
    );

    await markSiteAwaitingDeploy({
      cognitoId,
      siteId,
      paymentType,
      planId,
      metadata: safeMetadata,
      renewDate,
      paymentId: String(orderId),
    });

    return response(200, {
      success: true,
      verified: true,
      provider: "PAYPAL",
      transactionId: String(transactionId),
      orderId: String(orderId),
      domainStatus: "awaiting_deploy",
    });
  } catch (err) {
    return response(500, {
      success: false,
      error: err?.response?.data || err.message,
    });
  }
};
