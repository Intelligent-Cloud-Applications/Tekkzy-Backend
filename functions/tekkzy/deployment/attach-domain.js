const {
  GetCommand,
  UpdateCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  GetDistributionCommand,
  UpdateDistributionCommand,
  CreateInvalidationCommand,
} = require("@aws-sdk/client-cloudfront");

const {
  dynamoDbClient,
  cloudfront,
} = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const {
  getClaim,
  updateClaimStatus,
} = require("../domain-payment/domainClaims");

const SITE_TABLE = process.env.SITE_TABLE;

const normalizeDomain = (value = "") =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

const siteOwnsDomain = (site, domain) => {
  if (!site || !domain) return false;
  const candidates = [
    site.requestedDomain,
    site.domain,
    site.domainName
      ? String(site.domainName).includes(".")
        ? site.domainName
        : `${site.domainName}.tekkzy.com`
      : null,
  ]
    .filter(Boolean)
    .map(normalizeDomain);

  return candidates.includes(domain);
};

const isPaidOrOwnedDomain = (site) => {
  const paymentStatus = String(site.paymentStatus || "").toLowerCase();
  const domainStatus = String(site.domainStatus || "").toLowerCase();
  const subscriptionStatus = String(site.subscriptionStatus || "").toLowerCase();

  if (paymentStatus === "paid") return true;
  if (["active", "awaiting_deploy", "provisioning", "paid"].includes(domainStatus)) {
    return true;
  }
  if (subscriptionStatus === "active" && (site.requestedDomain || site.domain)) {
    return true;
  }
  if (site.status === "LIVE" && (site.requestedDomain || site.domain)) {
    return true;
  }
  return false;
};

const retargetCloudFrontOrigin = async (cloudfrontId, targetSiteId) => {
  const distRes = await cloudfront.send(
    new GetDistributionCommand({ Id: cloudfrontId })
  );

  const config = distRes.Distribution?.DistributionConfig;
  const etag = distRes.ETag;

  if (!config?.Origins?.Items?.length) {
    throw new Error("CloudFront distribution has no origins to retarget.");
  }

  const nextPath = `/${String(targetSiteId)}`;
  config.Origins.Items = config.Origins.Items.map((origin, index) => {
    if (index === 0) {
      return { ...origin, OriginPath: nextPath };
    }
    return origin;
  });
  config.Comment = `Distribution for ${targetSiteId}`;

  await cloudfront.send(
    new UpdateDistributionCommand({
      Id: cloudfrontId,
      IfMatch: etag,
      DistributionConfig: config,
    })
  );

  try {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: cloudfrontId,
        InvalidationBatch: {
          CallerReference: `${targetSiteId}-${Date.now()}`,
          Paths: { Quantity: 1, Items: ["/*"] },
        },
      })
    );
  } catch (err) {
    console.warn("CloudFront invalidation skipped:", err?.message || err);
  }
};

const clearDomainFromSite = async (userId, siteId) => {
  const nowIso = new Date().toISOString();

  await dynamoDbClient.send(
    new UpdateCommand({
      TableName: SITE_TABLE,
      Key: { userId, siteId },
      UpdateExpression: `
        SET domainStatus = :detached,
            paymentStatus = :unpaid,
            #status = :draft,
            updatedAt = :updatedAt
        REMOVE requestedDomain, #domain, domainType, deployType,
               cloudfrontId, cloudfrontDomain, certificateArn, certStatus,
               hostedZoneId, lastPaymentId
      `.replace(/\s+/g, " ").trim(),
      ExpressionAttributeNames: {
        "#domain": "domain",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":detached": "detached",
        ":unpaid": "unpaid",
        ":draft": "DRAFT",
        ":updatedAt": nowIso,
      },
    })
  );
};

module.exports.main = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const targetSiteId = String(body.siteId || "").trim();
    const domain = normalizeDomain(body.domain || "");
    const sourceSiteIdHint = body.sourceSiteId
      ? String(body.sourceSiteId).trim()
      : null;
    const userId = event.requestContext?.identity?.cognitoIdentityId;

    if (!userId) {
      return response(401, { success: false, message: "Unauthorized" });
    }
    if (!targetSiteId || !domain) {
      return response(400, {
        success: false,
        message: "siteId and domain are required",
      });
    }

    const targetRes = await dynamoDbClient.send(
      new GetCommand({
        TableName: SITE_TABLE,
        Key: { userId, siteId: targetSiteId },
      })
    );

    if (!targetRes.Item) {
      return response(404, { success: false, message: "Target site not found" });
    }

    const listed = await dynamoDbClient.send(
      new QueryCommand({
        TableName: SITE_TABLE,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      })
    );

    const userSites = listed.Items || [];
    let sourceSite = null;

    if (sourceSiteIdHint) {
      sourceSite = userSites.find((s) => s.siteId === sourceSiteIdHint) || null;
    }
    if (!sourceSite) {
      sourceSite =
        userSites.find(
          (s) =>
            s.siteId !== targetSiteId &&
            siteOwnsDomain(s, domain) &&
            isPaidOrOwnedDomain(s)
        ) || null;
    }

    if (!sourceSite) {
      // Same site already owns it — treat as attach/resume.
      const self = userSites.find(
        (s) => s.siteId === targetSiteId && siteOwnsDomain(s, domain)
      );
      if (self && isPaidOrOwnedDomain(self)) {
        const deployType =
          self.deployType ||
          (self.domainType === "subdomain" ? "subdomain" : "connect");
        return response(200, {
          success: true,
          reused: true,
          sameSite: true,
          domain,
          displayDomain: domain,
          sourceSiteId: targetSiteId,
          deployType,
          domainType: self.domainType || (deployType === "subdomain" ? "subdomain" : "custom"),
          hostedZoneId: self.hostedZoneId || null,
          reusedInfrastructure: Boolean(self.cloudfrontId),
          needsFullDeploy: !self.cloudfrontId,
          paymentStatus: "paid",
          domainStatus: self.cloudfrontId ? "active" : "awaiting_deploy",
        });
      }

      return response(404, {
        success: false,
        message: "No paid domain found for this account matching that name.",
      });
    }

    if (!siteOwnsDomain(sourceSite, domain) || !isPaidOrOwnedDomain(sourceSite)) {
      return response(403, {
        success: false,
        message: "You do not own this paid domain.",
      });
    }

    const claim = await getClaim(domain);
    if (claim && String(claim.ownerCognitoId) !== String(userId)) {
      return response(403, {
        success: false,
        message: "Domain claim belongs to another account.",
      });
    }

    const deployType =
      sourceSite.deployType === "register" || sourceSite.domainType === "custom"
        ? "connect"
        : sourceSite.deployType ||
          (sourceSite.domainType === "subdomain" ? "subdomain" : "connect");
    const domainType =
      sourceSite.domainType ||
      (deployType === "subdomain" ? "subdomain" : "custom");
    const nowIso = new Date().toISOString();
    const canRetarget = Boolean(sourceSite.cloudfrontId);

    if (canRetarget) {
      await retargetCloudFrontOrigin(sourceSite.cloudfrontId, targetSiteId);
    }

    const targetValues = {
      ":domain": domain,
      ":domainStatus": canRetarget ? "active" : "awaiting_deploy",
      ":paymentStatus": "paid",
      ":subStatus": sourceSite.subscriptionStatus || "active",
      ":domainType": domainType,
      ":deployType": deployType,
      ":billingCycle": sourceSite.billingCycle || "monthly",
      ":updatedAt": nowIso,
      ":status": canRetarget ? "LIVE" : sourceSite.status === "LIVE" ? "DRAFT" : "DRAFT",
    };

    let targetUpdate =
      "SET requestedDomain = :domain, #domain = :domain, domainStatus = :domainStatus, paymentStatus = :paymentStatus, subscriptionStatus = :subStatus, domainType = :domainType, deployType = :deployType, billingCycle = :billingCycle, updatedAt = :updatedAt, #status = :status";

    if (sourceSite.productPurchased) {
      targetUpdate += ", productPurchased = :product";
      targetValues[":product"] = sourceSite.productPurchased;
    }
    if (sourceSite.planRenewalDate) {
      targetUpdate += ", planRenewalDate = :renew";
      targetValues[":renew"] = sourceSite.planRenewalDate;
    }
    if (sourceSite.deployContact) {
      targetUpdate += ", deployContact = :contact";
      targetValues[":contact"] = sourceSite.deployContact;
    }
    if (sourceSite.hostedZoneId) {
      targetUpdate += ", hostedZoneId = :hostedZoneId";
      targetValues[":hostedZoneId"] = sourceSite.hostedZoneId;
    }
    if (sourceSite.lastPaymentId) {
      targetUpdate += ", lastPaymentId = :paymentId";
      targetValues[":paymentId"] = sourceSite.lastPaymentId;
    }
    if (canRetarget) {
      targetUpdate +=
        ", cloudfrontId = :cfId, cloudfrontDomain = :cfDomain, certificateArn = :certArn, certStatus = :certStatus";
      targetValues[":cfId"] = sourceSite.cloudfrontId;
      targetValues[":cfDomain"] = sourceSite.cloudfrontDomain || null;
      targetValues[":certArn"] = sourceSite.certificateArn || null;
      targetValues[":certStatus"] = sourceSite.certStatus || "ISSUED";
    }

    await dynamoDbClient.send(
      new UpdateCommand({
        TableName: SITE_TABLE,
        Key: { userId, siteId: targetSiteId },
        UpdateExpression: targetUpdate,
        ExpressionAttributeNames: {
          "#domain": "domain",
          "#status": "status",
        },
        ExpressionAttributeValues: targetValues,
      })
    );

    await clearDomainFromSite(userId, sourceSite.siteId);

    if (claim) {
      await updateClaimStatus(domain, claim.status || "active", {
        siteId: targetSiteId,
        ownerCognitoId: userId,
      });
    }

    return response(200, {
      success: true,
      domain,
      displayDomain: domain,
      sourceSiteId: sourceSite.siteId,
      deployType,
      domainType,
      hostedZoneId: sourceSite.hostedZoneId || null,
      reusedInfrastructure: canRetarget,
      needsFullDeploy: !canRetarget,
      paymentStatus: "paid",
      domainStatus: canRetarget ? "active" : "awaiting_deploy",
      billingCycle: sourceSite.billingCycle || "monthly",
    });
  } catch (err) {
    console.error("attach-domain error:", err);
    return response(500, {
      success: false,
      error: err.message || "Failed to attach domain",
    });
  }
};
