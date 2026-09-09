const {
  cloudfront,
  CreateDistributionCommand
} = require("../../../Utils/awsConfig");

const { dynamoDbClient } = require("../../../Utils/awsConfig");

const {
  GetCommand,
  UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const { response } = require("../../../Utils/Functions");

const SITE_TABLE = process.env.SITE_TABLE;
const SITE_DEPLOY_BUCKET = process.env.SITE_DEPLOY_BUCKET;
const SITE_REGION = "us-east-1";

const normalizeBucketName = (raw = "") => {
  const value = String(raw).trim().toLowerCase().replace(/^https?:\/\//, "");

  const host = value.split("/")[0];

  if (host.includes(".s3-website")) {
    return host.split(".s3-website")[0];
  }

  if (host.includes(".s3.")) {
    return host.split(".s3.")[0];
  }

  if (host.includes(".s3-")) {
    return host.split(".s3-")[0];
  }

  return host;
};

module.exports.main = async (event) => {

  try {

    const { siteId } = JSON.parse(event.body || {});
    const userId = event.requestContext.identity.cognitoIdentityId;

    if (!siteId || !userId) {
      return response(400,{
        success:false,
        message:"siteId required"
      });
    }

    /* ---------- Get Site ---------- */

    const siteRes = await dynamoDbClient.send(
      new GetCommand({
        TableName:SITE_TABLE,
        Key:{ userId, siteId }
      })
    );

    const site = siteRes.Item;

    if (!site) {
      return response(404,{
        success:false,
        message:"Site not found"
      });
    }

    if (site.cloudfrontId) {
      return response(200,{
        success:true,
        message:"CloudFront already created",
        cloudfrontId:site.cloudfrontId,
        cloudfrontDomain:site.cloudfrontDomain
      });
    }

    const bucket = normalizeBucketName(site.bucket || SITE_DEPLOY_BUCKET);
    const domain = site.requestedDomain;
    const certificateArn = site.certificateArn;

    if (!bucket || !domain || !certificateArn) {
      return response(400,{
        success:false,
        message:"Missing bucket, domain or certificate"
      });
    }

    /* ---------- Create CloudFront ---------- */

    const distribution = await cloudfront.send(
      new CreateDistributionCommand({
        DistributionConfig:{
          CallerReference:Date.now().toString(),
          Comment:`Distribution for ${siteId}`,
          Enabled:true,
          DefaultRootObject:"index.html",

          Origins:{
            Quantity:1,
            Items:[
              {
                Id:"S3Origin",
                DomainName:`${bucket}.s3-website.${SITE_REGION}.amazonaws.com`,
                OriginPath:`/${siteId}`,
                CustomOriginConfig:{
                  HTTPPort:80,
                  HTTPSPort:443,
                  OriginProtocolPolicy:"http-only"
                }
              }
            ]
          },

          DefaultCacheBehavior:{
            TargetOriginId:"S3Origin",
            ViewerProtocolPolicy:"redirect-to-https",

            AllowedMethods:{
              Quantity:2,
              Items:["GET","HEAD"]
            },

            CachedMethods:{
              Quantity:2,
              Items:["GET","HEAD"]
            },

            CachePolicyId:"658327ea-f89d-4fab-a63d-7e88639e58f6"
          },

          Aliases:{
            Quantity:1,
            Items:[domain]
          },

          ViewerCertificate:{
            ACMCertificateArn:certificateArn,
            SSLSupportMethod:"sni-only",
            MinimumProtocolVersion:"TLSv1.2_2021"
          },

          CustomErrorResponses:{
            Quantity:2,
            Items:[
              {
                ErrorCode:403,
                ResponsePagePath:"/index.html",
                ResponseCode:"200",
                ErrorCachingMinTTL:0
              },
              {
                ErrorCode:404,
                ResponsePagePath:"/index.html",
                ResponseCode:"200",
                ErrorCachingMinTTL:0
              }
            ]
          }
        }
      })
    );

    const dist = distribution.Distribution;

    /* ---------- Save to DB ---------- */

    await dynamoDbClient.send(
      new UpdateCommand({
        TableName:SITE_TABLE,
        Key:{ userId, siteId },
        UpdateExpression:
        "SET cloudfrontId=:id, cloudfrontDomain=:domain, #status=:status, updatedAt=:updatedAt",
        ExpressionAttributeNames:{
          "#status":"status"
        },
        ExpressionAttributeValues:{
          ":id":dist.Id,
          ":domain":dist.DomainName,
          ":status":"DEPLOYING",
          ":updatedAt":new Date().toISOString()
        }
      })
    );

    return response(200,{
      success:true,
      message:"CloudFront distribution created",
      cloudfrontId:dist.Id,
      cloudfrontDomain:dist.DomainName
    });

  } catch(err){

    console.error("CloudFront creation error:",err);

    return response(500,{
      success:false,
      error:err.message
    });

  }

};