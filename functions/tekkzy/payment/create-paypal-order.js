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

const getPayPalCredentials = () => {
  const clientId =
    process.env.PAYPAL_CLIENT_ID || process.env.AWSAIAPP_PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET || process.env.AWSAIAPP_PAYPAL_SECRET;

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

    const { siteId, planId, paymentType, metadata } = body;

    if (!siteId || !planId || !paymentType) {
      return response(400, {
        success: false,
        message: "siteId, planId, paymentType required",
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

    const orderPayload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: String(siteId),
          custom_id: JSON.stringify({
            siteId: String(siteId),
            planId: String(planId),
            paymentType: String(paymentType),
            countryCode: String(countryCode || ""),
          }),
          amount: {
            currency_code: pricing.currency,
            value: pricing.amount.toFixed(2),
          },
          description:
            paymentType === "domain-registration"
              ? "Tekkzy domain registration"
              : "Tekkzy hosting plan",
        },
      ],
      application_context: {
        user_action: "PAY_NOW",
      },
    };

    const orderRes = await axios.post(`${PAYPAL_BASE_URL}/v2/checkout/orders`, orderPayload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const order = orderRes?.data;

    const paymentItem = {
      cognitoId: String(cognitoId),
      paymentId: String(order.id),
      amount: pricing.amount,
      currency: pricing.currency,
      active: true,
      institution: "tekkzy",
      productId: String(siteId),
      planId: String(planId),
      subscriptionType: String(paymentType),
      paymentMode: "PayPal",
      paymentDate: Date.now(),
      renewDate: null,
      isVerified: false,
      siteId: String(siteId),
      paypalOrderId: String(order.id),
      status: "PENDING",
      countryCode: countryCode || null,
      metadata: metadata || null,
    };

    await dynamoDB.send(
      new PutCommand({
        TableName: process.env.PAYMENT_TABLE_NAME,
        Item: paymentItem,
      })
    );

    return response(200, {
      success: true,
      provider: "PAYPAL",
      orderId: order.id,
      order,
      plan: {
        amount: pricing.amount,
        currency: pricing.currency,
        interval: pricing.interval,
      },
      paymentRecord: {
        paymentId: paymentItem.paymentId,
        status: paymentItem.status,
        isVerified: paymentItem.isVerified,
      },
    });
  } catch (error) {
    return response(500, {
      success: false,
      error: error?.response?.data || error.message,
    });
  }
};
