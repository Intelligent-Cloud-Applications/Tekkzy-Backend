const { PutCommand, dynamoDB, getS3ClientForRegion, PutObjectCommand } = require('../../Utils/awsConfig');
const { response, parseBase64Image } = require('../../Utils/Functions');
const { v4: uuidv4 } = require('uuid');
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
            templateName,
            domainUrl,
            templateLink,
            description,
            category,
            templateType,
            thumbnail: providedThumbnail,
            thumbnailBase64,
            templateData: providedTemplateData
        } = data;

        const resolvedDomainUrl = domainUrl || templateLink;

        // Validation: Required input fields
        if (!templateName || !resolvedDomainUrl || !description) {
            return response(400, { error: 'templateName, domainUrl (or templateLink), and description are required' });
        }

        const normalizedDomainUrl = resolvedDomainUrl.replace(/\/$/, '');

        // Use templateData from request body, or fetch from live site's data.json
        let templateData = providedTemplateData;
        if (!templateData || typeof templateData !== 'object' || Object.keys(templateData).length === 0) {
            const dataJsonUrl = `${normalizedDomainUrl}/data.json`;
            try {
                const fetchResponse = await axios.get(dataJsonUrl);
                templateData = fetchResponse.data;
            } catch (fetchErr) {
                console.error(`Error fetching template data from ${dataJsonUrl}:`, fetchErr.message);
                return response(400, {
                    error: `Failed to fetch template configuration from ${dataJsonUrl}`,
                    message: fetchErr.message,
                    hint: 'Include templateData in the request body if data.json is not deployed on the website'
                });
            }
        }

        if (!templateData || typeof templateData !== 'object') {
            return response(400, { error: 'Invalid templateData: must be a non-empty object' });
        }

        if (Object.keys(templateData).length === 0) {
            return response(400, { error: 'Validation failed: templateData is empty or invalid' });
        }

        const resolvedCategoryRaw = category ?? templateType ?? templateData.templateType;
        const resolvedCategory =
            typeof resolvedCategoryRaw === 'string' && resolvedCategoryRaw.trim()
                ? resolvedCategoryRaw.trim()
                : 'General';
        const categoryKey = resolvedCategory.toLowerCase().replace(/\s+/g, ' ');

        // Generate templateId and templateNo before thumbnail upload
        const templateId = `tmpl-${uuidv4()}`;
        const templateNo = '1';

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

        // Helper function to convert relative URLs to absolute URLs
        const makeAbsoluteUrl = (url, baseUrl) => {
            if (!url) return '';
            // If already absolute URL, return as-is
            if (url.startsWith('http://') || url.startsWith('https://')) {
                return url;
            }
            // If relative path, prepend base URL
            if (url.startsWith('/')) {
                return `${baseUrl}${url}`;
            }
            return url;
        };

        // Extract thumbnail: prioritize frontend-provided thumbnail
        let thumbnailUrl = '';
        if (providedThumbnail) {
            thumbnailUrl = makeAbsoluteUrl(providedThumbnail, normalizedDomainUrl);
        } else if (templateData.thumbnail) {
            thumbnailUrl = makeAbsoluteUrl(templateData.thumbnail, normalizedDomainUrl);
        } else if (templateData.hero && templateData.hero.backgroundImage) {
            thumbnailUrl = makeAbsoluteUrl(templateData.hero.backgroundImage, normalizedDomainUrl);
        }

        // Upload thumbnail to S3 if available
        let thumbnail = '';
        if (thumbnailBase64) {
            const parsedImage = parseBase64Image(thumbnailBase64);
            if (!parsedImage) {
                return response(400, { error: 'Invalid thumbnailBase64: could not decode image data' });
            }

            try {
                thumbnail = await uploadThumbnailBuffer(
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
        } else if (thumbnailUrl) {
            // Handle URL thumbnail
            try {
                const thumbnailResponse = await axios.get(thumbnailUrl, { responseType: 'arraybuffer' });
                const thumbnailBuffer = Buffer.from(thumbnailResponse.data);
                const contentType = thumbnailResponse.headers['content-type'] || 'image/jpeg';
                const extension = contentType.includes('png') ? 'png' : 'jpg';

                thumbnail = await uploadThumbnailBuffer(thumbnailBuffer, contentType, extension);
            } catch (thumbnailErr) {
                console.error('Error uploading thumbnail to S3:', thumbnailErr.message);
                // Continue without thumbnail rather than failing the entire upload
                thumbnail = '';
            }
        }

        let title = templateName;
        if (templateData.title) {
            title = templateData.title;
        } else if (templateData.hero && templateData.hero.title) {
            if (typeof templateData.hero.title === 'string') {
                title = templateData.hero.title;
            } else if (templateData.hero.title.line1) {
                title = templateData.hero.title.line1 + (templateData.hero.title.line2 ? ' ' + templateData.hero.title.line2 : '');
            }
        }

        // Prepare item for DynamoDB
        const item = {
            templateId,
            templateNo,
            templateName,
            description,
            category: resolvedCategory,
            categoryKey,
            templateType: resolvedCategory,
            domainUrl: normalizedDomainUrl,
            thumbnail,
            title,
            templateData,
            createdAt: new Date().toISOString()
        };

        const params = {
            TableName: process.env.BETA_TEMPLATE_TABLE,
            Item: item
        };

        // Save to DynamoDB
        await dynamoDB.send(new PutCommand(params));

        return response(200, {
            message: 'Template uploaded successfully',
            template: item
        });

    } catch (err) {
        console.error('upload-template error', err);
        return response(500, {
            error: err.message || 'Internal Server Error'
        });
    }
};
