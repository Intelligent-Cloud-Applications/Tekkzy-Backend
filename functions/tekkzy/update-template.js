const { GetCommand, PutCommand, dynamoDB, getS3ClientForRegion, PutObjectCommand } = require('../../Utils/awsConfig');
const { response, parseBase64Image } = require('../../Utils/Functions');
const axios = require('axios');

module.exports.main = async (event) => {
    try {
        // Parse request body
        let data = {};
        if (event.body) {
            try {
                data = JSON.parse(event.body);
            } catch (e) {
                return response(400, { error: 'Invalid JSON in request body' });
            }
        }

        // Handle payload wrapper if present
        if (data.payload) {
            data = data.payload;
        }

        const {
            templateId,
            templateNo,
            templateName,
            description,
            category,
            templateType,
            thumbnail,
            thumbnailBase64,
            icon,
            templateLink
        } = data;

        const resolvedCategory = category ?? templateType;

        // templateId and templateNo are required to identify which template to update
        if (!templateId || templateNo === undefined || templateNo === null) {
            return response(400, { error: 'templateId and templateNo are required' });
        }

        // DynamoDB key requires templateNo as a String type
        const templateNoStr = String(templateNo);

        // Fetch existing template from DynamoDB
        const getParams = {
            TableName: process.env.BETA_TEMPLATE_TABLE,
            Key: { templateId, templateNo: templateNoStr }
        };

        const existing = await dynamoDB.send(new GetCommand(getParams));

        if (!existing || !existing.Item) {
            return response(404, { error: 'Template not found' });
        }

        const bucket = process.env.TEMPLATE_ASSETS_BUCKET || 'institution-utils';
        const region = process.env.TEMPLATE_ASSETS_BUCKET_REGION || 'us-east-1';
        const templateAssetsS3 = getS3ClientForRegion(region);

        const uploadThumbnailBuffer = async (thumbnailBuffer, contentType, extension) => {
            const thumbnailKey = `tekkzy-templates/${templateId}/thumbnail-${Date.now()}.${extension}`;

            await templateAssetsS3.send(new PutObjectCommand({
                Bucket: bucket,
                Key: thumbnailKey,
                Body: thumbnailBuffer,
                ContentType: contentType
            }));

            return `https://${bucket}.s3.${region}.amazonaws.com/${thumbnailKey}`;
        };

        // Handle thumbnail upload to S3 if provided
        let finalThumbnail = existing.Item.thumbnail;
        if (thumbnailBase64) {
            const parsedImage = parseBase64Image(thumbnailBase64);
            if (!parsedImage) {
                return response(400, { error: 'Invalid thumbnailBase64: could not decode image data' });
            }

            try {
                finalThumbnail = await uploadThumbnailBuffer(
                    parsedImage.buffer,
                    parsedImage.contentType,
                    parsedImage.extension
                );
            } catch (thumbnailErr) {
                console.error('Error uploading base64 thumbnail to S3:', thumbnailErr);
                return response(500, {
                    error: 'Failed to upload thumbnail to S3',
                    message: thumbnailErr.message
                });
            }
        } else if (thumbnail) {
            // Handle URL or S3 URL thumbnail
            try {
                let thumbnailSource = thumbnail;
                if (!thumbnailSource.startsWith('http://') && !thumbnailSource.startsWith('https://')) {
                    const baseUrl = (templateLink ?? existing.Item.templateLink ?? existing.Item.domainUrl ?? '').replace(/\/$/, '');
                    if (baseUrl && thumbnailSource.startsWith('/')) {
                        thumbnailSource = `${baseUrl}${thumbnailSource}`;
                    }
                }

                // Check if it's a URL that needs to be downloaded and uploaded to S3
                if (thumbnailSource.startsWith('http://') || thumbnailSource.startsWith('https://')) {
                    // Check if it's already an S3 URL
                    if (!thumbnailSource.includes('.s3.') && !thumbnailSource.includes('.s3-')) {
                        const thumbnailResponse = await axios.get(thumbnailSource, { responseType: 'arraybuffer' });
                        const thumbnailBuffer = Buffer.from(thumbnailResponse.data);
                        const contentType = thumbnailResponse.headers['content-type'] || 'image/jpeg';
                        const extension = contentType.includes('png') ? 'png' : 'jpg';

                        finalThumbnail = await uploadThumbnailBuffer(thumbnailBuffer, contentType, extension);
                    } else {
                        // Already an S3 URL, use as-is
                        finalThumbnail = thumbnailSource;
                    }
                } else {
                    finalThumbnail = thumbnail;
                }
            } catch (thumbnailErr) {
                console.error('Error uploading thumbnail to S3:', thumbnailErr.message);
                // Continue with existing thumbnail if upload fails
            }
        }

        const nextCategory =
            typeof resolvedCategory === 'string' && resolvedCategory.trim()
                ? resolvedCategory.trim()
                : null;
        const categoryKey = nextCategory
            ? nextCategory.toLowerCase().replace(/\s+/g, ' ')
            : existing.Item.categoryKey ||
              (existing.Item.category
                  ? String(existing.Item.category).toLowerCase().replace(/\s+/g, ' ')
                  : undefined);

        // Merge new fields into existing item, preserving any fields not sent
        const updatedItem = {
            ...existing.Item,
            templateId,
            templateNo: templateNoStr,
            templateName: templateName ?? existing.Item.templateName,
            description: description ?? existing.Item.description,
            category: nextCategory ?? existing.Item.category,
            categoryKey:
                categoryKey ||
                (existing.Item.category
                    ? String(existing.Item.category).toLowerCase().replace(/\s+/g, ' ')
                    : 'general'),
            templateType: nextCategory ?? existing.Item.templateType,
            thumbnail: finalThumbnail,
            icon: icon ?? existing.Item.icon,
            templateLink: templateLink ?? existing.Item.templateLink,
            updatedAt: new Date().toISOString()
        };

        // Write updated item back to DynamoDB
        const putParams = {
            TableName: process.env.BETA_TEMPLATE_TABLE,
            Item: updatedItem
        };

        await dynamoDB.send(new PutCommand(putParams));

        return response(200, {
            message: 'Template updated successfully',
            item: updatedItem
        });

    } catch (err) {

        console.log('update-template error', err);

        return response(500, {
            error: err.message || 'Internal Server Error'
        });

    }
};
