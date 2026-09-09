const Razorpay = require("razorpay");
const { PutCommand, dynamoDB } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const { PLAN_CATALOG } = require("./planCatalog");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_TEST_KEY_ID,
  key_secret: process.env.RAZORPAY_TEST_SECRET_KEY
});

const hasRazorpayTestConfig = () =>
  Boolean(process.env.RAZORPAY_TEST_KEY_ID && process.env.RAZORPAY_TEST_SECRET_KEY);

module.exports.main = async (event) => {
  try {
    const cognitoId = event?.requestContext?.identity?.cognitoIdentityId;
    if (!cognitoId) {
      return response(401, {
        success: false,
        message: "Unauthorized: cognitoId not found in request context"
      });
    }

    const body =
      typeof event.body === "string"
        ? JSON.parse(event.body || "{}")
        : (event.body || {});

    const { siteId, planId, paymentType } = body;

    if (!siteId || !planId || !paymentType) {
      return response(400, {
        success: false,
        message: "siteId, planId, paymentType required"
      });
    }

    const catalogPlan = PLAN_CATALOG[paymentType]?.[planId];
    if (!catalogPlan) {
      return response(400, {
        success: false,
        message: "Invalid paymentType or planId"
      });
    }

    const amount = Number(catalogPlan.amountByCurrency?.INR || catalogPlan.amount);
    if (!amount) {
      return response(400, {
        success: false,
        message: "Plan amount not configured",
      });
    }

    const plan = {
      ...catalogPlan,
      amount,
      currency: "INR",
    };

    if (!hasRazorpayTestConfig()) {
      return response(500, {
        success: false,
        message: "Razorpay test keys are not configured"
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
              description: `${paymentType} subscription for ${planId}`
            }
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
      }
    });

    const paymentItem = {
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
      emailId: event?.requestContext?.identity?.email || "",
      isVerified: false,
      siteId: String(siteId),
      razorpayPlanId: String(razorpayPlanId),
      razorpaySubscriptionId: String(subscription.id),
      status: "PENDING"
    };

    await dynamoDB.send(
      new PutCommand({
        TableName: process.env.PAYMENT_TABLE_NAME,
        Item: paymentItem
      })
    );

    return response(200, {
      success: true,
      keyId: process.env.RAZORPAY_TEST_KEY_ID,
      mode: "subscription",
      subscription,
      plan: {
        id: razorpayPlanId,
        period: plan.period,
        interval: plan.interval,
        amount: plan.amount,
        currency: plan.currency
      },
      paymentRecord: {
        paymentId: paymentItem.paymentId,
        status: paymentItem.status,
        isVerified: paymentItem.isVerified
      }
    });

  } catch (err) {
    return response(500, {
      success: false,
      error: err.message
    });
  }
};