const crypto = require("crypto");
const Razorpay = require("razorpay");
const { PutCommand, dynamoDB } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const { PLAN_CATALOG } = require("./planCatalog");

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_TEST_KEY_ID,
    key_secret: process.env.RAZORPAY_TEST_SECRET_KEY,
});

const hasRazorpayTestConfig = () =>
    Boolean(
        process.env.RAZORPAY_TEST_KEY_ID && process.env.RAZORPAY_TEST_SECRET_KEY
    );

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


module.exports.main = async (event) => {
    try {
        if (!hasRazorpayTestConfig()) {
            return response(500, {
                success: false,
                message: "Razorpay test keys are not configured",
            });
        }

        const cognitoId = event?.requestContext?.identity?.cognitoIdentityId;
        if (!cognitoId) {
            return response(401, {
                success: false,
                message: "Unauthorized: cognitoId not found in request context",
            });
        }

        const body =
            typeof event.body === "string"
                ? JSON.parse(event.body || "{}")
                : event.body || {};

        const {
            razorpay_order_id,
            razorpay_subscription_id,
            razorpay_payment_id,
            razorpay_signature,
            siteId,
            planId,
            paymentType,
            amount,
            currency,
            customer,
            metadata,
        } = body;

        if (!razorpay_payment_id || !razorpay_signature) {
            return response(400, {
                success: false,
                message:
                    "razorpay_payment_id and razorpay_signature required",
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

        let resolvedAmount = amount;
        let resolvedCurrency = currency || "INR";

        if (siteId || planId || paymentType) {
            if (!siteId || !planId || !paymentType) {
                return response(400, {
                    success: false,
                    message: "siteId, planId, paymentType must be provided together",
                });
            }

            const expectedPlan = PLAN_CATALOG[paymentType]?.[planId];
            if (!expectedPlan) {
                return response(400, {
                    success: false,
                    message: "Invalid paymentType or planId",
                });
            }

            const catalogAmount = Number(
                expectedPlan.amountByCurrency?.[resolvedCurrency] ||
                    expectedPlan.amountByCurrency?.INR ||
                    expectedPlan.amount,
            );
            if (!catalogAmount) {
                return response(400, {
                    success: false,
                    message: "Plan amount not configured",
                });
            }

            let noteSiteId;
            let notePlanId;
            let notePaymentType;

            if (razorpay_subscription_id) {
                const subscription = await razorpay.subscriptions.fetch(razorpay_subscription_id);
                noteSiteId = subscription?.notes?.siteId;
                notePlanId = subscription?.notes?.planId;
                notePaymentType = subscription?.notes?.paymentType;
            } else {
                if (!razorpay_order_id) {
                    return response(400, {
                        success: false,
                        message: "razorpay_order_id required for non-subscription verification",
                    });
                }

                const order = await razorpay.orders.fetch(razorpay_order_id);
                noteSiteId = order?.notes?.siteId;
                notePlanId = order?.notes?.planId;
                notePaymentType = order?.notes?.paymentType;
            }

            if (
                String(noteSiteId) !== String(siteId) ||
                String(notePlanId) !== String(planId) ||
                String(notePaymentType) !== String(paymentType)
            ) {
                return response(400, {
                    success: false,
                    message: "Subscription/order metadata does not match the requested plan/site",
                });
            }

            resolvedAmount = catalogAmount;
            resolvedCurrency = resolvedCurrency || "INR";
        }

        const paymentDateEpoch = Date.now();
        const now = new Date(paymentDateEpoch).toISOString();
        const billingPeriod = resolveBillingPeriod(paymentType, planId);
        const renewDate = computeRenewDate(paymentDateEpoch, billingPeriod);
        const safeCustomer = customer
            ? removeUndefinedDeep(customer)
            : null;
        const safeMetadata = metadata
            ? removeUndefinedDeep(metadata)
            : null;
        const paymentRecord = {
            transactionId: "rzp_" + razorpay_payment_id,
            razorpayOrderId: razorpay_order_id || null,
            razorpaySubscriptionId: razorpay_subscription_id || null,
            razorpayPaymentId: razorpay_payment_id || null,
            siteId: siteId || null,
            planId: planId || null,
            paymentType: paymentType || null,
            billingPeriod,
            amount: Number(resolvedAmount || 0),
            currency: resolvedCurrency || "INR",
            customer: safeCustomer,
            metadata: safeMetadata,
            status: "SUCCESS",
            verifiedAt: now,
            renewDate,
        };

        const paymentId = String(razorpay_subscription_id || razorpay_payment_id);
        await dynamoDB.send(
            new PutCommand({
                TableName: process.env.PAYMENT_TABLE_NAME,
                Item: {
                    cognitoId: String(cognitoId),
                    paymentId,
                    amount: Number(resolvedAmount || 0),
                    currency: resolvedCurrency || "INR",
                    active: true,
                    institution: "tekkzy",
                    productId: String(siteId || ""),
                    planId: String(planId || ""),
                    subscriptionType: String(paymentType || ""),
                    billingPeriod,
                    paymentMode: "Razorpay",
                    paymentDate: paymentDateEpoch,
                    renewDate,
                    isVerified: true,
                    siteId: siteId || null,
                    razorpayOrderId: razorpay_order_id || null,
                    razorpaySubscriptionId: razorpay_subscription_id || null,
                    razorpayPaymentId: razorpay_payment_id || null,
                    transactionId: paymentRecord.transactionId,
                    status: "SUCCESS",
                    verifiedAt: now,
                    customer: safeCustomer,
                    metadata: safeMetadata,
                },
            })
        );

        return response(200, {
            success: true,
            verified: true,
            transactionId: paymentRecord.transactionId,
            cognitoId: String(cognitoId),
            subscriptionId: razorpay_subscription_id || null,
        });
    } catch (err) {
        return response(500, {
            success: false,
            error: err.message,
        });
    }
};