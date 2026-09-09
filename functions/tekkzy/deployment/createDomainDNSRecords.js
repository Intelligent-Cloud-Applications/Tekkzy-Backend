const {
  route53,
  ChangeResourceRecordSetsCommand
} = require("../../../Utils/awsConfig");

const { dynamoDbClient } = require("../../../Utils/awsConfig");

const {
  GetCommand,
  UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const { response } = require("../../../Utils/Functions");

const SITE_TABLE = process.env.SITE_TABLE;

const PLATFORM_HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID;

module.exports.main = async (event) => {

  try {

    const { siteId, hostedZoneId: frontendZone } = JSON.parse(event.body || {});
    const userId = event.requestContext.identity.cognitoIdentityId;

    if (!siteId) {
      return response(400, {
        success: false,
        message: "siteId required"
      });
    }

    /* ---------- Get Site ---------- */

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

    const domain = site.requestedDomain.toLowerCase().replace(/\.$/, "");
    const cloudfrontDomain = site.cloudfrontDomain;

    if (!cloudfrontDomain) {
      return response(400, {
        success: false,
        message: "CloudFront not ready"
      });
    }

    const hostedZoneId = frontendZone || PLATFORM_HOSTED_ZONE_ID || null;

    /* ---------- AUTO DNS ---------- */

    if (hostedZoneId) {

      try {

        const result = await route53.send(
          new ChangeResourceRecordSetsCommand({
            HostedZoneId: hostedZoneId,
            ChangeBatch: {
              Changes: [
                {
                  Action: "UPSERT",
                  ResourceRecordSet: {
                    Name: domain,
                    Type: "A",
                    AliasTarget: {
                      DNSName: cloudfrontDomain,
                      HostedZoneId: "Z2FDTNDATAQYW2",
                      EvaluateTargetHealth: false
                    }
                  }
                },
                {
                  Action: "UPSERT",
                  ResourceRecordSet: {
                    Name: domain,
                    Type: "AAAA",
                    AliasTarget: {
                      DNSName: cloudfrontDomain,
                      HostedZoneId: "Z2FDTNDATAQYW2",
                      EvaluateTargetHealth: false
                    }
                  }
                }
              ]
            }
          })
        );

        await dynamoDbClient.send(
          new UpdateCommand({
            TableName: SITE_TABLE,
            Key: { userId, siteId },
            UpdateExpression:
              "SET #domain=:domain, #status=:status, updatedAt=:updatedAt",
            ExpressionAttributeNames: {
              "#domain": "domain",
              "#status": "status"
            },
            ExpressionAttributeValues: {
              ":domain": domain,
              ":status": "LIVE",
              ":updatedAt": new Date().toISOString()
            }
          })
        );

        return response(200, {
          success: true,
          message: "DNS configured automatically",
          changeId: result.ChangeInfo.Id
        });

      } catch (err) {

        console.warn("Auto DNS failed → fallback manual:", err.message);

        return response(200, {
          success: true,
          type: "MANUAL",
          message: "Automatic DNS setup failed. Add this record manually.",
          dnsRecord: {
            type: "CNAME",
            name: domain,
            value: cloudfrontDomain
          }
        });

      }

    }

    /* ---------- MANUAL DNS ---------- */

    return response(200, {
      success: true,
      type: "MANUAL",
      message: "Add this DNS record in your domain provider",
      dnsRecord: {
        type: "CNAME",
        name: domain,
        value: cloudfrontDomain
      }
    });

  } catch (err) {

    console.error("DNS setup error:", err);

    return response(500, {
      success: false,
      error: err.message
    });

  }

};