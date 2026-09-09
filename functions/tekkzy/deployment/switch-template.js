const { S3Client, dynamoDbClient } = require("../../../Utils/awsConfig");
const {
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const {
  CloudFrontClient,
  CreateInvalidationCommand,
} = require("@aws-sdk/client-cloudfront");

const { GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const { response } = require("../../../Utils/Functions");

const SITE_TABLE = process.env.SITE_TABLE;
const SITE_DEPLOY_BUCKET = process.env.SITE_DEPLOY_BUCKET;
const SITE_REGION = "us-east-1";

const s3Client = new S3Client({ region: SITE_REGION });
const cloudfront = new CloudFrontClient({ region: SITE_REGION });

/* ------------------------------------------------ */
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
/* ------------------------------------------------ */

const listKeysByPrefix = async (bucket, prefix) => {
  const keys = [];
  let continuationToken;

  do {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    keys.push(...(result.Contents || []).map((obj) => obj.Key));
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return keys;
};
/* ------------------------------------------------ */

const deleteKeys = async (bucket, keys) => {
  if (!keys.length) return;

  const batchSize = 1000;

  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);

    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }
};
/* ------------------------------------------------ */

const encodeCopySource = (bucket, key) =>
  `${encodeURIComponent(bucket)}/${key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;

/* ------------------------------------------------ */
/* Wait until object exists in S3 */

const waitForObject = async (bucket, key, retries = 10) => {
  for (let i = 0; i < retries; i++) {
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      return true;
    } catch (err) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error(`Object ${key} not available after copy`);
};

const syncSiteDataJson = async (bucket, siteId, sourceBucket) => {
  const dataKey = `${siteId}/data.json`;

  if (sourceBucket) {
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: sourceBucket,
          Key: "data.json",
        })
      );

      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: encodeCopySource(sourceBucket, "data.json"),
          Key: dataKey,
          CacheControl: "no-cache, no-store, must-revalidate",
          MetadataDirective: "REPLACE",
          ContentType: "application/json",
        })
      );

      return "copied";
    } catch (err) {
      if (err?.$metadata?.httpStatusCode !== 404 && err?.name !== "NotFound") {
        throw err;
      }
    }
  }

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: dataKey,
      Body: "{}",
      ContentType: "application/json",
      CacheControl: "no-cache, no-store, must-revalidate",
    })
  );

  return "defaulted";
};

/* ------------------------------------------------ */
/* SERIAL TEMPLATE COPY */

const copyTemplateToSitePrefix = async (sourceBucket, destinationBucket, siteId) => {
  const templateKeys = await listKeysByPrefix(sourceBucket, "");

  const sourceKeys = templateKeys.filter((key) => {
    if (!key) return false;
    if (key.endsWith("/")) return false;
    if (key.startsWith("sites/")) return false;
    if (key.startsWith(`${siteId}/`)) return false;
    if (key === "data.json") return false;
    return true;
  });

  if (!sourceKeys.length) {
    throw new Error("No source template files found in selected template bucket");
  }

  const hasIndexHtml = sourceKeys.includes("index.html");
  if (!hasIndexHtml) {
    throw new Error("Selected template bucket is missing index.html");
  }

  /* Copy index.html first to avoid 404 */
  sourceKeys.sort((a, b) => {
    if (a === "index.html") return -1;
    if (b === "index.html") return 1;
    return 0;
  });

  let copiedFiles = 0;

  for (const key of sourceKeys) {
    const destinationKey = `${siteId}/${key}`;

    await s3Client.send(
      new CopyObjectCommand({
        Bucket: destinationBucket,
        CopySource: encodeCopySource(sourceBucket, key),
        Key: destinationKey,
      })
    );

    copiedFiles++;
  }

  /* Ensure index.html exists before continuing */
  await waitForObject(destinationBucket, `${siteId}/index.html`);

  return {
    copiedFiles,
    hasIndexHtml,
  };
};

/* ------------------------------------------------ */

const invalidateDistributionCache = async (distributionId, siteId) => {
  const invalidation = await cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `switch-${siteId}-${Date.now()}`,
        Paths: {
          Quantity: 1,
          Items: ["/*"],
        },
      },
    })
  );

  return invalidation?.Invalidation?.Id || null;
};

/* ------------------------------------------------ */

module.exports.main = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    const { siteId, templateId, templateNo, templateUrl } = body;

    const userId = event?.requestContext?.identity?.cognitoIdentityId;

    if (!userId) {
      return response(401, {
        success: false,
        message: "Unauthorized",
      });
    }

    if (!siteId || !templateId || !templateNo || !templateUrl) {
      return response(400, {
        success: false,
        message:
          "siteId, templateId, templateNo and templateUrl are required",
      });
    }

    const siteResult = await dynamoDbClient.send(
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

    if (!SITE_DEPLOY_BUCKET) {
      return response(500, {
        success: false,
        message: "SITE_DEPLOY_BUCKET is not configured",
      });
    }

    const deployBucket = normalizeBucket(SITE_DEPLOY_BUCKET);
    const sourceBucket = normalizeBucket(new URL(templateUrl).hostname);

    const sitePrefix = `${siteId}/`;

    /* Clean existing deployed files before template switch */
    const existingKeys = await listKeysByPrefix(deployBucket, sitePrefix);
    await deleteKeys(deployBucket, existingKeys);

    /* Copy template */
    const copyResult = await copyTemplateToSitePrefix(sourceBucket, deployBucket, siteId);
    const dataSyncMode = await syncSiteDataJson(deployBucket, siteId, sourceBucket);

    let invalidationId = null;

    if (site.cloudfrontId) {
      invalidationId = await invalidateDistributionCache(
        site.cloudfrontId,
        siteId
      );
    }

    const nextStatus = site.cloudfrontId ? "LIVE" : "FILES_READY";

    const s3Path = `${siteId}/data.json`;

    await dynamoDbClient.send(
      new UpdateCommand({
        TableName: SITE_TABLE,
        Key: { userId, siteId },

        UpdateExpression:
          "SET templateId=:templateId, templateNo=:templateNo, templateUrl=:templateUrl, #bucket=:bucket, sitePrefix=:sitePrefix, #status=:status, s3Path=:s3Path, updatedAt=:updatedAt",

        ExpressionAttributeNames: {
          "#status": "status",
          "#bucket": "bucket",
        },

        ExpressionAttributeValues: {
          ":templateId": templateId,
          ":templateNo": templateNo,
          ":templateUrl": templateUrl,
          ":bucket": deployBucket,
          ":sitePrefix": siteId,
          ":status": nextStatus,
          ":updatedAt": new Date().toISOString(),
          ":s3Path": s3Path,
        },
      })
    );

    return response(200, {
      success: true,
      message: "Theme switched successfully",
      siteId,
      sourceBucket,
      deployBucket,
      copiedFiles: copyResult.copiedFiles,
      dataSyncMode,
      invalidationId,
    });
  } catch (err) {
    console.error("Switch template error:", err);

    return response(500, {
      success: false,
      error: err.message,
    });
  }
};