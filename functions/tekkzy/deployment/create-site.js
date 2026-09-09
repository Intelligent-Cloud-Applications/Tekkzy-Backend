const { nanoid } = require("nanoid");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");

const { dynamoDbClient } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");

const SITE_TABLE = process.env.SITE_TABLE;
const SITE_DEPLOY_BUCKET = process.env.SITE_DEPLOY_BUCKET;

const normalizeBucket = (value = "") => {
  const host = String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];

  if (host.includes(".s3-website")) return host.split(".s3-website")[0];
  if (host.includes(".s3.")) return host.split(".s3.")[0];
  if (host.includes(".s3-")) return host.split(".s3-")[0];

  return host;
};

module.exports.main = async (event) => {
  try {

    const userId = event.requestContext.identity.cognitoIdentityId;

    if (!userId) {
      return response(401, {
        success: false,
        message: "Unauthorized"
      });
    }

    const body = JSON.parse(event.body || "{}");

    const { templateId, templateNo, templateUrl } = body;

    if (!templateId || !templateNo || !templateUrl) {
      return response(400, {
        success: false,
        message: "templateId, templateNo and templateUrl are required"
      });
    }

    if (!SITE_DEPLOY_BUCKET) {
      return response(500, {
        success: false,
        message: "SITE_DEPLOY_BUCKET is not configured"
      });
    }

    /* ---------- Generate Site ID ---------- */

    const siteId = `site_${nanoid(8)}`;

    const bucket = normalizeBucket(SITE_DEPLOY_BUCKET);

    const sitePrefix = siteId;

    const now = new Date().toISOString();

    /* ---------- Minimal Site Record ---------- */

    const siteRecord = {
      userId,
      siteId,
      templateId,
      templateNo,
      templateUrl,
      bucket,
      sitePrefix,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now
    };

    /* ---------- Save ---------- */

    await dynamoDbClient.send(
      new PutCommand({
        TableName: SITE_TABLE,
        Item: siteRecord,
        ConditionExpression: "attribute_not_exists(siteId)"
      })
    );

    return response(201, {
      success: true,
      message: "Site draft created",
      siteId
    });

  } catch (err) {

    console.error("Create site error:", err);

    return response(500, {
      success: false,
      error: err.message
    });

  }
};