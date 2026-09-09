const axios = require("axios");
const Razorpay = require("razorpay");
const { PutCommand, dynamoDB } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const { PLAN_CATALOG } = require("./planCatalog");

const PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_TEST_KEY_ID,
  key_secret: process.env.RAZORPAY_TEST_SECRET_KEY,
});

const getCountryCodeFromRequest = (event, body) => {
  const bodyCountry = String(body?.countryCode || "").toUpperCase();
  if (bodyCountry) return bodyCountry;

  const headers = event?.headers || {};
  return String(
    headers["CloudFront-Viewer-Country"] || headers["cloudfront-viewer-country"] || ""
  ).toUpperCase();
};

const resolveProviderByCountry = (countryCode) => {
  const normalizedCountry = String(countryCode || "").toUpperCase();
  return normalizedCountry === "IN" ? "RAZORPAY" : "PAYPAL";
};

const resolveCurrencyByProvider = (provider) => {
  return provider === "RAZORPAY" ? "INR" : "USD";
};

const getPlanPricing = ({ paymentType, planId, currency }) => {
  const plan = PLAN_CATALOG[paymentType]?.[planId];
  if (!plan) return null;

  const amount = Number(plan.amountByCurrency?.[currency]);
  if (!amount) return null;

  return {
    ...plan,
    amount,
    currency,
  };
};

const hasRazorpayTestConfig = () =>
  Boolean(process.env.RAZORPAY_TEST_KEY_ID && process.env.RAZORPAY_TEST_SECRET_KEY);

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

    const { siteId, planId, paymentType, metadata } = body;

    if (!siteId || !planId || !paymentType) {
      return response(400, {
        success: false,
        message: "siteId, planId, paymentType required",
      });
    }

    const countryCode = getCountryCodeFromRequest(event, body);
    const provider = resolveProviderByCountry(countryCode);
    const currency = resolveCurrencyByProvider(provider);
    const plan = getPlanPricing({ paymentType, planId, currency });

    if (!plan) {
      return response(400, {
        success: false,
        message: "Invalid paymentType/planId or unsupported pricing",
      });
    }

    if (provider === "RAZORPAY") {
      if (!hasRazorpayTestConfig()) {
        return response(500, {
          success: false,
          message: "Razorpay test keys are not configured",
        });
      }

      const razorpayPlanId = plan.razorpayPlanId
        ? String(plan.razorpayPlanId)
        : (
            await razorpay.plans.create({
              period: plan.period,
              interval: Number(plan.interval || 1),
              item: {
                name: plan.name,
                amount: Number(plan.amount) * 100,
                currency: plan.currency,
                description: `${paymentType} subscription for ${planId}`,
              },
            })
          ).id;

      const subscription = await razorpay.subscriptions.create({
        plan_id: razorpayPlanId,
        customer_notify: 1,
        total_count: Number(plan.totalCount || 120),
        notes: {
          siteId: String(siteId),
          planId: String(planId),
          paymentType: String(paymentType),
          razorpayPlanId: String(razorpayPlanId),
          billingCycle: String(plan.period),
        },
      });

      await dynamoDB.send(
        new PutCommand({
          TableName: process.env.PAYMENT_TABLE_NAME,
          Item: {
            cognitoId: String(cognitoId),
            paymentId: String(subscription.id),
            amount: Number(plan.amount),
            currency: plan.currency,
            active: true,
            institution: "tekkzy",
            productId: String(siteId),
            planId: String(planId),
            subscriptionType: String(paymentType),
            paymentMode: "Razorpay",
            paymentDate: Date.now(),
            renewDate: subscription?.current_start || subscription?.start_at || null,
            isVerified: false,
            siteId: String(siteId),
            razorpayPlanId: String(razorpayPlanId),
            razorpaySubscriptionId: String(subscription.id),
            countryCode: countryCode || null,
            metadata: metadata || null,
            status: "PENDING",
          },
        })
      );

      return response(200, {
        success: true,
        provider,
        countryCode: countryCode || null,
        plan: {
          amount: Number(plan.amount),
          currency: plan.currency,
          period: plan.period,
          interval: plan.interval,
        },
        razorpay: {
          keyId: process.env.RAZORPAY_TEST_KEY_ID,
          subscriptionId: subscription.id,
          planId: razorpayPlanId,
        },
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
            currency_code: plan.currency,
            value: Number(plan.amount).toFixed(2),
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

    await dynamoDB.send(
      new PutCommand({
        TableName: process.env.PAYMENT_TABLE_NAME,
        Item: {
          cognitoId: String(cognitoId),
          paymentId: String(order.id),
          amount: Number(plan.amount),
          currency: plan.currency,
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
          countryCode: countryCode || null,
          metadata: metadata || null,
          status: "PENDING",
        },
      })
    );

    return response(200, {
      success: true,
      provider,
      countryCode: countryCode || null,
      plan: {
        amount: Number(plan.amount),
        currency: plan.currency,
      },
      paypal: {
        clientId,
        orderId: order.id,
        order,
      },
    });
  } catch (error) {
    return response(500, {
      success: false,
      error: error?.response?.data || error.message,
    });
  }
};
