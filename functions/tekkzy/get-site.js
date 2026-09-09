const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { GetObjectCommand } = require("@aws-sdk/client-s3");

const { dynamoDbClient, S3Client } = require("../../Utils/awsConfig");
const { response } = require("../../Utils/Functions");

const s3Client = new S3Client({
  region: "us-east-1"
});

const SITE_TABLE = process.env.SITE_TABLE;
const SITE_DEPLOY_BUCKET = process.env.SITE_DEPLOY_BUCKET;

/* ---------- Helper to convert S3 stream ---------- */

const streamToString = async (stream) =>
  await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf-8"))
    );
  });

module.exports.main = async (event) => {

  try {

    const { siteId } = event.queryStringParameters || {};
    const userId = event.requestContext.identity.cognitoIdentityId;

    if (!siteId) {
      return response(400, {
        success: false,
        message: "siteId required"
      });
    }

    /* ---------- Get Site From DynamoDB ---------- */

    const siteResult = await dynamoDbClient.send(
      new GetCommand({
        TableName: SITE_TABLE,
        Key: {
          userId,
          siteId
        }
      })
    );

    const site = siteResult.Item;

    if (!site) {
      return response(404, {
        success: false,
        message: "Site not found"
      });
    }

    /* ---------- Fetch data.json from S3 ---------- */

    let siteData = null;

    const bucket = site.bucket || SITE_DEPLOY_BUCKET;
    const key = site.s3Path || `${siteId}/data.json`;

    if (bucket && key) {

      try {
        const s3Object = await s3Client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key
          })
        );

        const jsonString = await streamToString(s3Object.Body);

        try {
          siteData = JSON.parse(jsonString);
        } catch {
          siteData = jsonString;
        }
      } catch (s3Err) {
        if (!["NoSuchKey", "NotFound"].includes(s3Err?.name)) {
          throw s3Err;
        }
      }
    }

    /* ---------- Response ---------- */

    return response(200, {
      success: true,
      data: {
        site,
        data: siteData
      }
    });

  } catch (err) {

    console.error("Get site error:", err);

    return response(500, {
      success: false,
      error: err.message
    });

  }

};