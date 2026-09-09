const {
  DeleteCommand,
  GetCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  dynamoDB,
  s3Client,
} = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");
const {
  getClaim,
  updateClaimStatus,
} = require("../domain-payment/domainClaims");

const SITE_TABLE = process.env.SITE_TABLE;
const SITE_DEPLOY_BUCKET = process.env.SITE_DEPLOY_BUCKET;

const getDisplayDomain = (site) => {
  if (!site) return "";
  return (
    site.requestedDomain ||
    site.domain ||
    (site.domainType === "subdomain" && site.domainName
      ? `${site.domainName}.tekkzy.com`
      : site.domainName) ||
    ""
  );
};

const deleteS3Prefix = async (bucket, prefix) => {
  if (!bucket || !prefix) return { deleted: 0 };

  let deleted = 0;
  let continuationToken;

  do {
    const listed = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
        ContinuationToken: continuationToken,
      })
    );

    const objects = listed.Contents || [];
    for (const object of objects) {
      if (!object.Key) continue;
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: object.Key,
        })
      );
      deleted += 1;
    }

    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return { deleted };
};

module.exports.main = async (event) => {
  try {
    const userId = event.requestContext?.identity?.cognitoIdentityId;

    if (!userId) {
      return response(401, {
        success: false,
        message: "Unauthorized",
      });
    }

    if (!SITE_TABLE) {
      return response(500, {
        success: false,
        message: "SITE_TABLE is not configured",
      });
    }

    const body = JSON.parse(event.body || "{}");
    const siteId = String(
      body.siteId || event.queryStringParameters?.siteId || ""
    ).trim();

    if (!siteId) {
      return response(400, {
        success: false,
        message: "siteId is required",
      });
    }

    const siteResult = await dynamoDB.send(
      new GetCommand({
        TableName: SITE_TABLE,
        Key: { userId, siteId },
      })
    );

    const site = siteResult.Item;
    if (!site) {
      return response(404, {
        success: false,
        message: "Site not found",
      });
    }

    const bucket = site.bucket || SITE_DEPLOY_BUCKET;
    const prefix = site.sitePrefix || siteId;

    let s3Cleanup = { deleted: 0 };
    try {
      s3Cleanup = await deleteS3Prefix(bucket, prefix);
    } catch (s3Err) {
      console.warn("Site S3 cleanup failed (continuing):", s3Err?.message || s3Err);
    }

    // Keep paid domain ownership, but detach this deleted site from the claim.
    const displayDomain = getDisplayDomain(site);
    if (displayDomain) {
      try {
        const claim = await getClaim(displayDomain);
        if (
          claim &&
          String(claim.ownerCognitoId) === String(userId) &&
          String(claim.siteId || "") === String(siteId)
        ) {
          await updateClaimStatus(displayDomain, claim.status || "active", {
            siteId: "",
          });
        }
      } catch (claimErr) {
        console.warn(
          "Domain claim detach failed (continuing):",
          claimErr?.message || claimErr
        );
      }
    }

    await dynamoDB.send(
      new DeleteCommand({
        TableName: SITE_TABLE,
        Key: { userId, siteId },
      })
    );

    return response(200, {
      success: true,
      message: "Site deleted",
      siteId,
      s3ObjectsDeleted: s3Cleanup.deleted,
    });
  } catch (err) {
    console.error("Delete site error:", err);
    return response(500, {
      success: false,
      message: err.message || "Failed to delete site",
    });
  }
};
