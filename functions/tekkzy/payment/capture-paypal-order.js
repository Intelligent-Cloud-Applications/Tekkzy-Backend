const axios = require("axios");
const { PutCommand, dynamoDB } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const { PLAN_CATALOG } = require("./planCatalog");

const PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";

const getCountryCodeFromRequest = (event, body) => {
  const bodyCountry = String(body?.countryCode || "").toUpperCase();
  if (bodyCountry) return bodyCountry;

  const headers = event?.headers || {};
  return String(
    headers["CloudFront-Viewer-Country"] || headers["cloudfront-viewer-country"] || ""
  ).toUpperCase();
};

const resolveCurrencyByCountry = (countryCode) => {
  return String(countryCode || "").toUpperCase() === "IN" ? "INR" : "USD";
};

const getPlanPricing = ({ paymentType, planId, currency }) => {
  const plan = PLAN_CATALOG[paymentType]?.[planId];
  if (!plan) return null;

  const amount = Number(plan.amountByCurrency?.[currency]);
  if (!amount) return null;

  return {
    currency,
    amount,
    interval: plan.period === "yearly" ? "year" : "month",
  };
};

const computeRenewDate = (paymentDateEpoch, interval) => {
  const renewDate = new Date(paymentDateEpoch);

  if (interval === "year") {
    renewDate.setFullYear(renewDate.getFullYear() + 1);
  } else {
    renewDate.setMonth(renewDate.getMonth() + 1);
  }

  return renewDate.getTime();
};

const getPayPalCredentials = () => {
  const clientId =
    process.env.AWSAIAPP_PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.AWSAIAPP_PAYPAL_SECRET || process.env.PAYPAL_SECRET;

  return { clientId, secret };
};

const getAccessToken = async (clientId, secret) => {
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

    const { orderId, siteId, planId, paymentType, customer, metadata } = body;

    if (!orderId || !siteId || !planId || !paymentType) {
      return response(400, {
        success: false,
        message: "orderId, siteId, planId, paymentType required",
      });
    }

    const countryCode = getCountryCodeFromRequest(event, body);
    const currency = resolveCurrencyByCountry(countryCode);
    const pricing = getPlanPricing({ paymentType, planId, currency });

    if (!pricing) {
      return response(400, {
        success: false,
        message: "Invalid plan or unsupported currency for plan",
      });
    }

    const { clientId, secret } = getPayPalCredentials();
    if (!clientId || !secret) {
      return response(500, {
        success: false,
        message: "PayPal credentials are not configured",
      });
    }

    const accessToken = await getAccessToken(clientId, secret);

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
    const capturedPurchaseUnit = captureData?.purchase_units?.[0];
    const capturedInfo = capturedPurchaseUnit?.payments?.captures?.[0];
    const capturedAmount = Number(capturedInfo?.amount?.value || 0);
    const capturedCurrency = String(capturedInfo?.amount?.currency_code || "").toUpperCase();

    if (captureData?.status !== "COMPLETED") {
      return response(400, {
        success: false,
        message: "PayPal capture is not completed",
        captureStatus: captureData?.status,
      });
    }

    if (
      capturedCurrency !== pricing.currency ||
      Number(capturedAmount.toFixed(2)) !== Number(pricing.amount.toFixed(2))
    ) {
      return response(400, {
        success: false,
        message: "Captured payment does not match expected plan amount",
        expected: {
          amount: pricing.amount,
          currency: pricing.currency,
        },
        actual: {
          amount: capturedAmount,
          currency: capturedCurrency,
        },
      });
    }

    const paymentDateEpoch = Date.now();
    const renewDate = computeRenewDate(paymentDateEpoch, pricing.interval);
    const transactionId = capturedInfo?.id || `paypal_${orderId}`;

    await dynamoDB.send(
      new PutCommand({
        TableName: process.env.PAYMENT_TABLE_NAME,
        Item: {
          cognitoId: String(cognitoId),
          paymentId: String(orderId),
          amount: pricing.amount,
          currency: pricing.currency,
          active: true,
          institution: "tekkzy",
          productId: String(siteId),
          planId: String(planId),
          subscriptionType: String(paymentType),
          paymentMode: "PayPal",
          paymentDate: paymentDateEpoch,
          renewDate,
          isVerified: true,
          siteId: String(siteId),
          transactionId: String(transactionId),
          paypalOrderId: String(orderId),
          paypalCaptureId: String(transactionId),
          status: "SUCCESS",
          verifiedAt: new Date(paymentDateEpoch).toISOString(),
          countryCode: countryCode || null,
          customer: customer || null,
          metadata: metadata || null,
        },
      })
    );

    return response(200, {
      success: true,
      verified: true,
      provider: "PAYPAL",
      transactionId: String(transactionId),
      orderId: String(orderId),
      captureId: String(transactionId),
    });
  } catch (error) {
    return response(500, {
      success: false,
      error: error?.response?.data || error.message,
    });
  }
};
