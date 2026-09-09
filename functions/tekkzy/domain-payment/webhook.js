const crypto = require("crypto");
const { GetCommand, UpdateCommand, dynamoDB } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const {
  computeRenewDate,
  computeGraceEndsAt,
  INSTITUTION,
} = require("./pricingConfig");
const { updateClaimStatus, releaseClaim } = require("./domainClaims");

const getWebhookSecret = () =>
  process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_TEST_SECRET_KEY;

const parseBody = (event) => {
  if (!event?.body) return {};
  if (typeof event.body === "string") {
    try {
      return JSON.parse(event.body);
    } catch {
      return {};
    }
  }
  return event.body;
};

const updateByNotes = async (notes, patch) => {
  const cognitoId = notes?.cognitoId;
  const paymentId =
    notes?.subscriptionId ||
    notes?.razorpaySubscriptionId ||
    notes?.paymentId;
  const siteId = notes?.siteId;
  const fullDomain = notes?.fullDomain;

  if (!cognitoId || !paymentId) {
    return { updated: false, reason: "missing cognitoId/paymentId in notes" };
  }

  const existing = await dynamoDB.send(
    new GetCommand({
      TableName: process.env.PAYMENT_TABLE_NAME,
      Key: { cognitoId: String(cognitoId), paymentId: String(paymentId) },
    })
  );

  const item = existing.Item;
  if (!item) {
    return { updated: false, reason: "payment not found" };
  }

  const processed = new Set(item.razorpayEventIds || []);
  if (patch.eventId && processed.has(patch.eventId)) {
    return { updated: false, alreadyProcessed: true };
  }

  const eventIds = [...processed];
  if (patch.eventId) eventIds.push(patch.eventId);

  let updateExpression =
    "SET #status = :status, updatedAt = :updatedAt, razorpayEventIds = :events";
  const values = {
    ":status": patch.status,
    ":updatedAt": Date.now(),
    ":events": eventIds,
  };

  if (patch.renewDate !== undefined) {
    updateExpression += ", renewDate = :renew";
    values[":renew"] = patch.renewDate;
  }
  if (patch.paidAt !== undefined) {
    updateExpression += ", paidAt = :paidAt, isVerified = :verified";
    values[":paidAt"] = patch.paidAt;
    values[":verified"] = true;
  }
  if (patch.graceEndsAt !== undefined) {
    updateExpression += ", graceEndsAt = :grace";
    values[":grace"] = patch.graceEndsAt;
  }

  await dynamoDB.send(
    new UpdateCommand({
      TableName: process.env.PAYMENT_TABLE_NAME,
      Key: { cognitoId: String(cognitoId), paymentId: String(paymentId) },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: values,
    })
  );

  if (patch.subscriptionStatus) {
    let profileUpdate =
      "SET subscription_status = :subStatus, updatedAt = :updatedAt";
    const profileValues = {
      ":subStatus": patch.subscriptionStatus,
      ":updatedAt": new Date().toISOString(),
    };
    if (patch.domainStatus) {
      profileUpdate += ", domain_status = :domainStatus";
      profileValues[":domainStatus"] = patch.domainStatus;
    }
    if (patch.renewDate !== undefined) {
      profileUpdate += ", plan_renewal_date = :renew";
      profileValues[":renew"] = patch.renewDate;
    }
    if (patch.graceEndsAt !== undefined) {
      profileUpdate += ", graceEndsAt = :grace";
      profileValues[":grace"] = patch.graceEndsAt;
    }

    await dynamoDB.send(
      new UpdateCommand({
        TableName: process.env.PROFILE_TABLE_NAME,
        Key: { institution: INSTITUTION, cognitoId: String(cognitoId) },
        UpdateExpression: profileUpdate,
        ExpressionAttributeValues: profileValues,
      })
    );
  }

  if (siteId && patch.siteDomainStatus) {
    let siteUpdate =
      "SET domainStatus = :domainStatus, subscriptionStatus = :subStatus, updatedAt = :updatedAt";
    const siteValues = {
      ":domainStatus": patch.siteDomainStatus,
      ":subStatus": patch.subscriptionStatus || item.status,
      ":updatedAt": new Date().toISOString(),
    };
    if (patch.renewDate !== undefined) {
      siteUpdate += ", planRenewalDate = :renew";
      siteValues[":renew"] = patch.renewDate;
    }
    if (patch.graceEndsAt !== undefined) {
      siteUpdate += ", graceEndsAt = :grace";
      siteValues[":grace"] = patch.graceEndsAt;
    }

    await dynamoDB.send(
      new UpdateCommand({
        TableName: process.env.SITE_TABLE,
        Key: { userId: String(cognitoId), siteId: String(siteId) },
        UpdateExpression: siteUpdate,
        ExpressionAttributeValues: siteValues,
      })
    );
  }

  if (fullDomain && patch.claimStatus) {
    if (patch.claimStatus === "released") {
      await releaseClaim(fullDomain);
    } else {
      await updateClaimStatus(fullDomain, patch.claimStatus, {
        graceEndsAt: patch.graceEndsAt || null,
      });
    }
  }

  return { updated: true };
};

module.exports.main = async (event) => {
  try {
    const secret = getWebhookSecret();
    if (!secret) {
      console.error("Razorpay webhook secret not configured");
      return response(500, { success: false, message: "Webhook not configured" });
    }

    const signature =
      event?.headers?.["X-Razorpay-Signature"] ||
      event?.headers?.["x-razorpay-signature"];

    const rawBody =
      typeof event.body === "string"
        ? event.body
        : JSON.stringify(event.body || {});

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    if (!signature || signature !== expected) {
      console.error("Invalid Razorpay webhook signature");
      return response(400, { success: false, message: "Invalid signature" });
    }

    const payload = parseBody(event);
    const eventId =
      payload?.event_id ||
      payload?.id ||
      `${payload?.event}-${Date.now()}`;
    const eventName = String(payload?.event || "");

    const sub = payload?.payload?.subscription?.entity || null;
    const paymentEntity = payload?.payload?.payment?.entity || null;

    const notes = {
      ...(sub?.notes || {}),
      ...(paymentEntity?.notes || {}),
      subscriptionId: sub?.id || paymentEntity?.subscription_id,
      razorpaySubscriptionId: sub?.id || paymentEntity?.subscription_id,
    };

    if (notes.flow && notes.flow !== "tekkzy-domain-deploy") {
      return response(200, { success: true, ignored: true });
    }

    if (
      eventName === "subscription.charged" ||
      eventName === "payment.captured" ||
      eventName === "invoice.paid"
    ) {
      const renewDate = sub?.current_end
        ? Number(sub.current_end) * 1000
        : computeRenewDate(Date.now(), notes.billingCycle || "monthly");

      await updateByNotes(notes, {
        eventId,
        status: "succeeded",
        paidAt: Date.now(),
        renewDate,
        subscriptionStatus: "active",
        claimStatus: "active",
      });

      return response(200, { success: true });
    }

    if (
      eventName === "payment.failed" ||
      eventName === "invoice.payment_failed" ||
      eventName === "subscription.pending"
    ) {
      const graceEndsAt = computeGraceEndsAt(Date.now());
      await updateByNotes(notes, {
        eventId,
        status: "failed",
        subscriptionStatus: "past_due",
        siteDomainStatus: "past_due",
        claimStatus: "past_due",
        graceEndsAt,
      });
      return response(200, { success: true });
    }

    if (
      eventName === "subscription.cancelled" ||
      eventName === "subscription.completed"
    ) {
      const graceEndsAt = computeGraceEndsAt(Date.now());
      await updateByNotes(notes, {
        eventId,
        status: "cancelled",
        subscriptionStatus: "cancelled",
        siteDomainStatus: "grace",
        claimStatus: "cancelled",
        graceEndsAt,
      });
      return response(200, { success: true });
    }

    return response(200, { success: true, ignored: true, event: eventName });
  } catch (err) {
    console.error("domain payment webhook error", err);
    return response(500, { success: false, message: err.message });
  }
};
