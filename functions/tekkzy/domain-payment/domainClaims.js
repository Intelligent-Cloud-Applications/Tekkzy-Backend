const {
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  dynamoDB,
} = require("../../../Utils/awsConfig");
const { DOMAIN_CLAIM_PK } = require("./pricingConfig");

const PAYMENT_TABLE = () => process.env.PAYMENT_TABLE_NAME;

const ACTIVE_CLAIM_STATUSES = new Set([
  "pending",
  "PENDING",
  "succeeded",
  "SUCCESS",
  "active",
  "past_due",
  "provisioning",
]);

const PENDING_CLAIM_TTL_MS = 60 * 60 * 1000;

const isClaimBlocking = (claim, now = Date.now()) => {
  if (!claim) return false;

  const status = String(claim.status || "");
  const graceEnded =
    claim.graceEndsAt && Number(claim.graceEndsAt) < now;

  if (
    ["cancelled", "deactivated", "released", "failed"].includes(status) &&
    (!claim.graceEndsAt || graceEnded)
  ) {
    return false;
  }

  if (status === "pending" || status === "PENDING") {
    const createdAt = Number(claim.createdAt || claim.updatedAt || 0);
    if (createdAt && now - createdAt > PENDING_CLAIM_TTL_MS) {
      return false;
    }
  }

  return ACTIVE_CLAIM_STATUSES.has(status);
};

const getClaim = async (fullDomain) => {
  const result = await dynamoDB.send(
    new GetCommand({
      TableName: PAYMENT_TABLE(),
      Key: {
        cognitoId: DOMAIN_CLAIM_PK,
        paymentId: String(fullDomain).toLowerCase(),
      },
    })
  );
  return result.Item || null;
};

/**
 * Soft-claim a domain at checkout time (conditional put).
 * Returns { ok: true } or { ok: false, reason }.
 */
const tryClaimDomain = async ({
  fullDomain,
  cognitoId,
  siteId,
  domainType,
  billingCycle,
}) => {
  const now = Date.now();
  const existing = await getClaim(fullDomain);

  if (existing) {
    const sameOwner = String(existing.ownerCognitoId) === String(cognitoId);

    // Same account can move a paid/claimed domain onto another site.
    if (sameOwner) {
      await dynamoDB.send(
        new PutCommand({
          TableName: PAYMENT_TABLE(),
          Item: {
            ...existing,
            siteId: String(siteId),
            domainType,
            billingCycle,
            status: existing.status || "pending",
            updatedAt: now,
          },
        })
      );
      return { ok: true, reused: true };
    }

    if (isClaimBlocking(existing, now)) {
      return { ok: false, reason: "This domain is already claimed." };
    }
  }

  try {
    await dynamoDB.send(
      new PutCommand({
        TableName: PAYMENT_TABLE(),
        Item: {
          cognitoId: DOMAIN_CLAIM_PK,
          paymentId: String(fullDomain).toLowerCase(),
          ownerCognitoId: String(cognitoId),
          siteId: String(siteId),
          domainType,
          billingCycle,
          status: "pending",
          createdAt: now,
          updatedAt: now,
          pendingExpiresAt: now + PENDING_CLAIM_TTL_MS,
          isDomainClaim: true,
          institution: "tekkzy",
        },
        ConditionExpression:
          "attribute_not_exists(paymentId) OR NOT (#status IN (:pending, :succeeded, :active, :past_due, :provisioning, :PENDING, :SUCCESS))",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":pending": "pending",
          ":PENDING": "PENDING",
          ":succeeded": "succeeded",
          ":SUCCESS": "SUCCESS",
          ":active": "active",
          ":past_due": "past_due",
          ":provisioning": "provisioning",
        },
      })
    );
    return { ok: true };
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      // Stale pending claim — overwrite if expired
      const again = await getClaim(fullDomain);
      if (again && !isClaimBlocking(again, now)) {
        await dynamoDB.send(
          new PutCommand({
            TableName: PAYMENT_TABLE(),
            Item: {
              cognitoId: DOMAIN_CLAIM_PK,
              paymentId: String(fullDomain).toLowerCase(),
              ownerCognitoId: String(cognitoId),
              siteId: String(siteId),
              domainType,
              billingCycle,
              status: "pending",
              createdAt: now,
              updatedAt: now,
              pendingExpiresAt: now + PENDING_CLAIM_TTL_MS,
              isDomainClaim: true,
              institution: "tekkzy",
            },
          })
        );
        return { ok: true };
      }
      return { ok: false, reason: "This domain was just claimed by someone else." };
    }
    throw err;
  }
};

const updateClaimStatus = async (fullDomain, status, extra = {}) => {
  const names = { "#status": "status" };
  const values = {
    ":status": status,
    ":updatedAt": Date.now(),
  };
  let update = "SET #status = :status, updatedAt = :updatedAt";

  Object.entries(extra).forEach(([key, value], index) => {
    const nameKey = `#e${index}`;
    const valueKey = `:e${index}`;
    names[nameKey] = key;
    values[valueKey] = value;
    update += `, ${nameKey} = ${valueKey}`;
  });

  await dynamoDB.send(
    new UpdateCommand({
      TableName: PAYMENT_TABLE(),
      Key: {
        cognitoId: DOMAIN_CLAIM_PK,
        paymentId: String(fullDomain).toLowerCase(),
      },
      UpdateExpression: update,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
};

const releaseClaim = async (fullDomain) => {
  await dynamoDB.send(
    new DeleteCommand({
      TableName: PAYMENT_TABLE(),
      Key: {
        cognitoId: DOMAIN_CLAIM_PK,
        paymentId: String(fullDomain).toLowerCase(),
      },
    })
  );
};

const isDomainAvailableForClaim = async (fullDomain, cognitoId, siteId) => {
  const claim = await getClaim(fullDomain);
  if (!claim) return { available: true };

  const now = Date.now();
  const sameOwner = String(claim.ownerCognitoId) === String(cognitoId);

  if (sameOwner) {
    return { available: true, ownedByRequester: true, siteId: claim.siteId };
  }

  if (isClaimBlocking(claim, now)) {
    return { available: false, reason: "This domain is already taken." };
  }

  return { available: true };
};

module.exports = {
  getClaim,
  tryClaimDomain,
  updateClaimStatus,
  releaseClaim,
  isDomainAvailableForClaim,
  ACTIVE_CLAIM_STATUSES,
};
