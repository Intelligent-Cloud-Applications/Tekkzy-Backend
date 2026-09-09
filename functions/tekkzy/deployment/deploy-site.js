const {
    S3Client,
    CloudFrontClient,
    CreateInvalidationCommand,
    dynamoDbClient
} = require("../../../Utils/awsConfig");

const {
    ListObjectsV2Command,
    CopyObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    GetObjectCommand
} = require("@aws-sdk/client-s3");

const {
    GetCommand,
    UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const { response } = require("../../../Utils/Functions");

const SITE_TABLE = process.env.SITE_TABLE;
const SITE_DEPLOY_BUCKET = process.env.SITE_DEPLOY_BUCKET;
const SITE_REGION = "us-east-1";

const s3Client = new S3Client({ region: SITE_REGION });
const cloudfront = new CloudFrontClient({ region: SITE_REGION });

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

const encodeCopySource = (bucket, key) =>
    `${encodeURIComponent(bucket)}/${key
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`;

/**
 * Templates are hosted either one-per-bucket (templaters.tekkzy.com -> bucket
 * root) or many-per-bucket under a slug prefix (products.tekkzy.com/resort2).
 * The prefix must be honoured, otherwise deploy copies the whole products
 * bucket (every template) and the published site is not the selected one.
 */
const resolveTemplateSource = (templateUrl) => {
    const withProtocol = /^https?:\/\//i.test(templateUrl)
        ? templateUrl
        : `https://${templateUrl}`;

    const parsed = new URL(withProtocol);
    const bucket = normalizeBucket(parsed.hostname);
    const prefix = parsed.pathname.replace(/^\/+|\/+$/g, "");

    return { bucket, prefix };
};

const CONTENT_TYPES = {
    html: "text/html",
    js: "application/javascript",
    mjs: "application/javascript",
    css: "text/css",
    json: "application/json",
    svg: "image/svg+xml",
    txt: "text/plain",
    webmanifest: "application/manifest+json"
};

const TEXT_EXTENSIONS = new Set(["html", "js", "mjs", "css", "json", "webmanifest", "txt"]);

const getExtension = (key) => key.split(".").pop().toLowerCase();

/**
 * Slug-prefixed template builds reference assets with absolute paths like
 * /resort2/assets/app.js. The deployed site serves from its own root, so
 * those references must be rewritten or every asset 404s.
 */
const copyTemplateObject = async ({ templateBucket, deployBucket, sourceKey, targetKey, prefix }) => {
    const extension = getExtension(sourceKey);

    if (prefix && TEXT_EXTENSIONS.has(extension)) {
        const object = await s3Client.send(
            new GetObjectCommand({
                Bucket: templateBucket,
                Key: sourceKey
            })
        );

        const body = await object.Body.transformToString("utf-8");
        const rewritten = body
            // Asset/link references: /slug/assets/x.js -> /assets/x.js
            .split(`/${prefix}/`).join("/")
            // Exact quoted basePath/basename, e.g. "/salon1" -> "".
            // Must be "" (not "/") so Next.js addBasePath("/contact") stays
            // "/contact" instead of becoming protocol-relative "//contact/".
            .split(`"/${prefix}"`).join(`""`)
            .split(`'/${prefix}'`).join(`''`);

        await s3Client.send(
            new PutObjectCommand({
                Bucket: deployBucket,
                Key: targetKey,
                Body: rewritten,
                ContentType: CONTENT_TYPES[extension] || object.ContentType || "application/octet-stream",
                CacheControl: object.CacheControl
            })
        );

        return;
    }

    await s3Client.send(
        new CopyObjectCommand({
            Bucket: deployBucket,
            CopySource: encodeCopySource(templateBucket, sourceKey),
            Key: targetKey
        })
    );
};

const ensureSiteDataJsonExists = async (bucket, siteId, templateBucket, templatePrefix) => {
    const dataKey = `${siteId}/data.json`;

    try {
        await s3Client.send(
            new HeadObjectCommand({
                Bucket: bucket,
                Key: dataKey
            })
        );

        return true;
    } catch (err) {
        if (err?.$metadata?.httpStatusCode !== 404 && err?.name !== "NotFound") {
            throw err;
        }
    }

    if (templateBucket) {
        const templateDataKey = templatePrefix ? `${templatePrefix}/data.json` : "data.json";

        try {
            await s3Client.send(
                new HeadObjectCommand({
                    Bucket: templateBucket,
                    Key: templateDataKey
                })
            );

            await s3Client.send(
                new CopyObjectCommand({
                    Bucket: bucket,
                    CopySource: encodeCopySource(templateBucket, templateDataKey),
                    Key: dataKey,
                    CacheControl: "no-cache, no-store, must-revalidate",
                    MetadataDirective: "REPLACE",
                    ContentType: "application/json"
                })
            );

            return false;
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
            CacheControl: "no-cache, no-store, must-revalidate"
        })
    );

    return false;
};

module.exports.main = async (event) => {

    try {

        const { siteId } = JSON.parse(event.body);
        const userId = event.requestContext.identity.cognitoIdentityId;

        if (!siteId) {
            return response(400, {
                success: false,
                message: "siteId required"
            });
        }

        /* ---------------- Get Site ---------------- */

        const siteRes = await dynamoDbClient.send(
            new GetCommand({
                TableName: SITE_TABLE,
                Key: { userId, siteId }
            })
        );

        const site = siteRes.Item;

        if (!site) {
            return response(404, {
                success: false,
                message: "Site not found"
            });
        }

        // if (site.status !== "LIVE") {
        //     return response(200, {
        //         success: true,
        //         message: "Template already deployed"
        //     });
        // }

        if (!SITE_DEPLOY_BUCKET) {
            return response(500, {
                success: false,
                message: "SITE_DEPLOY_BUCKET is not configured"
            });
        }

        if (!site.templateUrl) {
            return response(400, {
                success: false,
                message: "templateUrl missing on site record"
            });
        }

        const { bucket: templateBucket, prefix: templatePrefix } = resolveTemplateSource(site.templateUrl);
        const deployBucket = SITE_DEPLOY_BUCKET;
        const listPrefix = templatePrefix ? `${templatePrefix}/` : "";

        /* ---------------- List Template Files ---------------- */

        let continuationToken;
        const objects = [];

        do {

            const result = await s3Client.send(
                new ListObjectsV2Command({
                    Bucket: templateBucket,
                    Prefix: listPrefix || undefined,
                    ContinuationToken: continuationToken
                })
            );

            objects.push(...(result.Contents || []));
            continuationToken = result.NextContinuationToken;

        } while (continuationToken);

        if (objects.length === 0) {
            return response(400, {
                success: false,
                message: `No template files found for ${site.templateUrl}`
            });
        }

        /* ---------------- Copy Files ---------------- */

        const batchSize = 20;

        for (let i = 0; i < objects.length; i += batchSize) {

            const batch = objects.slice(i, i + batchSize);

            await Promise.all(
                batch.map(obj => {

                    const sourceKey = obj.Key;

                    if (!sourceKey || sourceKey.endsWith("/")) return null;

                    // Path relative to the template root (strip slug prefix).
                    const relativeKey = listPrefix ? sourceKey.slice(listPrefix.length) : sourceKey;

                    if (!relativeKey) return null;
                    if (relativeKey.startsWith("sites/")) return null;
                    if (relativeKey.startsWith(`${siteId}/`)) return null;
                    if (relativeKey === "data.json") return null;

                    return copyTemplateObject({
                        templateBucket,
                        deployBucket,
                        sourceKey,
                        targetKey: `${siteId}/${relativeKey}`,
                        prefix: templatePrefix
                    });

                }).filter(Boolean)
            );

        }

        await ensureSiteDataJsonExists(deployBucket, siteId, templateBucket, templatePrefix);

        /* ---------------- Invalidate CDN ---------------- */

        // Redeploys of already-live sites replace index.html/assets, but
        // CloudFront keeps serving cached copies until invalidated.
        if (site.cloudfrontId) {
            try {
                await cloudfront.send(
                    new CreateInvalidationCommand({
                        DistributionId: site.cloudfrontId,
                        InvalidationBatch: {
                            CallerReference: `deploy-${siteId}-${Date.now()}`,
                            Paths: {
                                Quantity: 1,
                                Items: ["/*"]
                            }
                        }
                    })
                );
            } catch (invalidationErr) {
                console.error("CloudFront invalidation failed:", invalidationErr);
            }
        }

        /* ---------------- Update DB ---------------- */

        await dynamoDbClient.send(
            new UpdateCommand({
                TableName: SITE_TABLE,
                Key: { userId, siteId },
                UpdateExpression:
                    "SET #status = :status, #bucket = :bucket, sitePrefix = :sitePrefix, s3Path = :s3Path, updatedAt = :updatedAt",
                ExpressionAttributeNames: {
                    "#status": "status",
                    "#bucket": "bucket"
                },
                ExpressionAttributeValues: {
                    // Redeploying a live site must not knock it out of LIVE.
                    ":status": site.status === "LIVE" ? "LIVE" : "FILES_READY",
                    ":bucket": deployBucket,
                    ":sitePrefix": siteId,
                    ":s3Path": `${siteId}/data.json`,
                    ":updatedAt": new Date().toISOString()
                }
            })
        );

        return response(200, {
            success: true,
            message: "Template deployed to site folder"
        });

    } catch (err) {

        console.error("Deploy site error:", err);

        return response(500, {
            success: false,
            error: err.message
        });

    }

};