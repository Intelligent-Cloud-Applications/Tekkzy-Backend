const {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
  getS3ClientForRegion,
  getSignedUrl,
} = require("../../Utils/awsConfig");
const { response } = require("../../Utils/Functions");

const DEFAULT_BUCKET = process.env.TEMPLATE_ASSETS_BUCKET || "institution-utils";
const DEFAULT_REGION =
  process.env.TEMPLATE_ASSETS_BUCKET_REGION || "us-east-1";

const ALLOWED_BUCKETS = new Set(
  [DEFAULT_BUCKET, "institution-utils"].filter(Boolean),
);

const sanitizeSegment = (value, fallback = "file") => {
  const cleaned = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.\./g, "")
    .replace(/[^a-zA-Z0-9._/-]/g, "_")
    .replace(/\/+/g, "/");
  return cleaned.replace(/^\/+|\/+$/g, "") || fallback;
};

const buildObjectKey = (folder, fileName) => {
  const safeFolder = sanitizeSegment(folder || "tekkzy", "tekkzy");
  const safeName = sanitizeSegment(fileName, `upload-${Date.now()}`);
  return `${safeFolder}/${safeName}`;
};

const resolvePublicUrl = (bucket, region, key) =>
  `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

module.exports.main = async (event) => {
  try {
    const userId = event?.requestContext?.identity?.cognitoIdentityId;
    if (!userId) {
      return response(401, {
        success: false,
        message: "Unauthorized",
      });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return response(400, { error: "Invalid JSON in request body" });
    }

    const action = String(body.action || "")
      .trim()
      .toUpperCase();
    const bucket = String(body.bucket || DEFAULT_BUCKET).trim();
    const region = String(body.region || DEFAULT_REGION).trim();
    const folder = body.folder || event?.pathParameters?.institution || "tekkzy";
    const fileName = body.fileName;
    const fileType = body.fileType || "application/octet-stream";

    if (!ALLOWED_BUCKETS.has(bucket)) {
      return response(400, {
        error: `Bucket not allowed. Use one of: ${[...ALLOWED_BUCKETS].join(", ")}`,
      });
    }

    if (!fileName) {
      return response(400, { error: "fileName is required" });
    }

    const key = buildObjectKey(folder, fileName);
    const s3 = getS3ClientForRegion(region);

    if (action === "INITIATE") {
      const result = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: fileType,
        }),
      );

      if (!result.UploadId) {
        return response(500, { error: "Failed to initiate multipart upload" });
      }

      return response(200, {
        uploadId: result.UploadId,
        key,
        bucket,
        region,
      });
    }

    if (action === "GET_PRESIGNED_URL") {
      const uploadId = body.uploadId;
      const partNumber = Number(body.partNumber);

      if (!uploadId) {
        return response(400, { error: "uploadId is required" });
      }
      if (!Number.isInteger(partNumber) || partNumber < 1) {
        return response(400, { error: "partNumber must be a positive integer" });
      }

      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

      return response(200, {
        presignedUrl,
        partNumber,
        uploadId,
        key,
      });
    }

    if (action === "COMPLETE") {
      const uploadId = body.uploadId;
      const parts = Array.isArray(body.parts) ? body.parts : [];

      if (!uploadId) {
        return response(400, { error: "uploadId is required" });
      }
      if (!parts.length) {
        return response(400, { error: "parts are required" });
      }

      const normalizedParts = parts
        .map((part) => ({
          ETag: part.ETag || part.etag || part.eTag,
          PartNumber: Number(part.PartNumber || part.partNumber),
        }))
        .filter(
          (part) =>
            part.ETag &&
            Number.isInteger(part.PartNumber) &&
            part.PartNumber > 0,
        )
        .sort((a, b) => a.PartNumber - b.PartNumber);

      if (!normalizedParts.length) {
        return response(400, {
          error: "parts must include ETag and PartNumber",
        });
      }

      try {
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: normalizedParts },
          }),
        );
      } catch (completeErr) {
        try {
          await s3.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            }),
          );
        } catch {
          // ignore abort errors
        }
        throw completeErr;
      }

      return response(200, {
        fileUrl: resolvePublicUrl(bucket, region, key),
        key,
        bucket,
        region,
      });
    }

    if (action === "ABORT") {
      const uploadId = body.uploadId;
      if (!uploadId) {
        return response(400, { error: "uploadId is required" });
      }

      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );

      return response(200, { success: true });
    }

    return response(400, {
      error: "Invalid action. Use INITIATE, GET_PRESIGNED_URL, COMPLETE, or ABORT",
    });
  } catch (err) {
    console.error("upload-file error", err);
    return response(500, {
      error: "Upload failed",
      message: err?.message || "Unknown error",
    });
  }
};
