const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const {
  S3Client,
  CloudFrontClient,
  CreateInvalidationCommand,
  dynamoDbClient
} = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");

const s3Client = new S3Client({ region: "us-east-1" });
const cloudfront = new CloudFrontClient({ region: "us-east-1" });

const SITE_TABLE = process.env.SITE_TABLE;
const SITE_DEPLOY_BUCKET = process.env.SITE_DEPLOY_BUCKET;

const invalidateDistributionCache = async (distributionId, siteId) => {
  const invalidation = await cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `update-data-${siteId}-${Date.now()}`,
        Paths: {
          Quantity: 1,
          Items: ["/data.json"]
        }
      }
    })
  );

  return invalidation?.Invalidation?.Id || null;
};

module.exports.main = async (event) => {

  try {

    const { siteId, data } = JSON.parse(event.body);
    const userId = event.requestContext.identity.cognitoIdentityId;

    if (!siteId || !data) {
      return response(400, {
        success: false,
        message: "siteId and data required"
      });
    }

    const jsonString = JSON.stringify(data);

    if (jsonString.length > 200000) {
      return response(400, {
        success: false,
        message: "Site data too large"
      });
    }

    /* ---------- Get Site ---------- */

    const siteResult = await dynamoDbClient.send(
      new GetCommand({
        TableName: SITE_TABLE,
        Key: { userId, siteId }
      })
    );

    const site = siteResult.Item;

    if (!site) {
      return response(404, {
        success: false,
        message: "Site not found"
      });
    }

    const bucket = site.bucket || SITE_DEPLOY_BUCKET;

    if (!bucket) {
      return response(500, {
        success: false,
        message: "SITE_DEPLOY_BUCKET is not configured"
      });
    }

    const key = `${siteId}/data.json`;

    /* ---------- Upload ---------- */

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: jsonString,
        ContentType: "application/json",
        CacheControl: "no-cache, no-store, must-revalidate"
      })
    );

    let invalidationId = null;

    if (site.cloudfrontId) {
      invalidationId = await invalidateDistributionCache(site.cloudfrontId, siteId);
    }

    /* ---------- Update DB ---------- */

    await dynamoDbClient.send(
      new UpdateCommand({
        TableName: SITE_TABLE,
        Key: { userId, siteId },
        UpdateExpression:
          "SET s3Path = :path, #bucket = :bucket, sitePrefix = :sitePrefix, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#bucket": "bucket"
        },
        ExpressionAttributeValues: {
          ":path": key,
          ":bucket": bucket,
          ":sitePrefix": siteId,
          ":updatedAt": new Date().toISOString()
        }
      })
    );

    return response(200, {
      success: true,
      message: "Site data updated",
      s3Path: key,
      invalidationId
    });

  } catch (err) {

    console.error("Update site error:", err);

    return response(500, {
      success: false,
      error: err.message
    });

  }

};