const { GetCommand, UpdateCommand, dynamoDB } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const { INSTITUTION, computeGraceEndsAt, GRACE_DAYS } = require("./pricingConfig");
const { releaseClaim, updateClaimStatus } = require("./domainClaims");

const parseBody = (event) => {
  if (!event?.body) return {};
  return typeof event.body === "string"
    ? JSON.parse(event.body || "{}")
    : event.body;
};

/**
 * Marks provisioning state and optionally finalizes active/failed.
 * Actual Route53/ACM/CloudFront steps continue to run via existing
 * frontend deployment sequence (setup-subdomain chain) after payment.
 * This endpoint is used for status updates + retry bookkeeping.
 */
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
    const siteId = String(body.siteId || "").trim();
    const action = String(body.action || "start").toLowerCase();
    const lastError = body.lastError ? String(body.lastError) : null;

    if (!siteId) {
      return response(400, {
        success: false,
        message: "siteId is required.",
      });
    }

    const siteRes = await dynamoDB.send(
      new GetCommand({
        TableName: process.env.SITE_TABLE,
        Key: { userId: cognitoId, siteId },
      })
    );

    const site = siteRes.Item;
    if (!site) {
      return response(403, {
        success: false,
        message: "You do not have access to this site.",
      });
    }

    const nowIso = new Date().toISOString();
    const fullDomain = site.requestedDomain || site.domain;

    if (action === "start" || action === "retry") {
      await dynamoDB.send(
        new UpdateCommand({
          TableName: process.env.SITE_TABLE,
          Key: { userId: cognitoId, siteId },
          UpdateExpression:
            "SET domainStatus = :status, provisionLastError = :err, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":status": "provisioning",
            ":err": null,
            ":updatedAt": nowIso,
          },
        })
      );

      await dynamoDB.send(
        new UpdateCommand({
          TableName: process.env.PROFILE_TABLE_NAME,
          Key: { institution: INSTITUTION, cognitoId },
          UpdateExpression:
            "SET domain_status = :status, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":status": "provisioning",
            ":updatedAt": nowIso,
          },
        })
      );

      return response(200, {
        success: true,
        domainStatus: "provisioning",
        fullDomain,
        message:
          "Provisioning started. SSL and CDN setup can take a few minutes.",
      });
    }

    if (action === "active" || action === "complete") {
      await dynamoDB.send(
        new UpdateCommand({
          TableName: process.env.SITE_TABLE,
          Key: { userId: cognitoId, siteId },
          UpdateExpression:
            "SET domainStatus = :status, #status = :live, domain = :domain, provisionLastError = :err, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "active",
            ":live": "LIVE",
            ":domain": fullDomain,
            ":err": null,
            ":updatedAt": nowIso,
          },
        })
      );

      await dynamoDB.send(
        new UpdateCommand({
          TableName: process.env.PROFILE_TABLE_NAME,
          Key: { institution: INSTITUTION, cognitoId },
          UpdateExpression:
            "SET domain_status = :status, domain_name = :domain, subscription_status = :sub, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":status": "active",
            ":domain": fullDomain,
            ":sub": "active",
            ":updatedAt": nowIso,
          },
        })
      );

      if (fullDomain) {
        await updateClaimStatus(fullDomain, "active");
      }

      return response(200, {
        success: true,
        domainStatus: "active",
        fullDomain,
      });
    }

    if (action === "failed") {
      await dynamoDB.send(
        new UpdateCommand({
          TableName: process.env.SITE_TABLE,
          Key: { userId: cognitoId, siteId },
          UpdateExpression:
            "SET domainStatus = :status, provisionLastError = :err, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":status": "failed",
            ":err": lastError || "Provisioning failed",
            ":updatedAt": nowIso,
          },
        })
      );

      await dynamoDB.send(
        new UpdateCommand({
          TableName: process.env.PROFILE_TABLE_NAME,
          Key: { institution: INSTITUTION, cognitoId },
          UpdateExpression:
            "SET domain_status = :status, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":status": "failed",
            ":updatedAt": nowIso,
          },
        })
      );

      return response(200, {
        success: true,
        domainStatus: "failed",
        lastError: lastError || "Provisioning failed",
        message:
          "Payment succeeded but domain setup failed. You can retry provisioning from this screen.",
      });
    }

    if (action === "deactivate") {
      const graceEndsAt = site.graceEndsAt || computeGraceEndsAt(Date.now());
      if (Date.now() < Number(graceEndsAt)) {
        return response(400, {
          success: false,
          message: `Domain is still in the ${GRACE_DAYS}-day grace period.`,
        });
      }

      await dynamoDB.send(
        new UpdateCommand({
          TableName: process.env.SITE_TABLE,
          Key: { userId: cognitoId, siteId },
          UpdateExpression:
            "SET domainStatus = :status, subscriptionStatus = :sub, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":status": "deactivated",
            ":sub": "cancelled",
            ":updatedAt": nowIso,
          },
        })
      );

      if (fullDomain) {
        await releaseClaim(fullDomain);
      }

      return response(200, {
        success: true,
        domainStatus: "deactivated",
        fullDomain,
      });
    }

    return response(400, {
      success: false,
      message: "Unknown action. Use start|retry|active|failed|deactivate.",
    });
  } catch (err) {
    console.error("provisionDomain error", err);
    return response(500, {
      success: false,
      message: "Unable to update provisioning status.",
      error: err.message,
    });
  }
};
