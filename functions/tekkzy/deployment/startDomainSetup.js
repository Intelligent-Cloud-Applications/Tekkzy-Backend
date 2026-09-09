const {
  acm,
  route53,
  dynamoDbClient,
  UpdateCommand,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  ChangeResourceRecordSetsCommand
} = require("../../../Utils/awsConfig");

const { response } = require("../../../Utils/Functions");

const SITE_TABLE = process.env.SITE_TABLE;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PLATFORM_HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID;

const normalizeDomain = (value = "") =>
  value
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.$/, "");

module.exports.main = async (event) => {

  try {

    const {
      siteId,
      domain,
      hostedZoneId: frontendZoneId
    } = JSON.parse(event.body || {});

    const userId = event.requestContext.identity.cognitoIdentityId;

    if (!siteId || !domain) {
      return response(400, {
        success: false,
        message: "siteId and domain are required"
      });
    }

    const normalizedDomain = normalizeDomain(domain);

    const hostedZoneId =
      frontendZoneId || PLATFORM_HOSTED_ZONE_ID || null;

    /* ------------------------------
       1️⃣ Request SSL Certificate
    ------------------------------ */

    const cert = await acm.send(
      new RequestCertificateCommand({
        DomainName: normalizedDomain,
        ValidationMethod: "DNS"
      })
    );

    const certificateArn = cert.CertificateArn;

    /* ------------------------------
       2️⃣ Wait for validation record
    ------------------------------ */

    let record;

    for (let i = 0; i < 10; i++) {

      const describe = await acm.send(
        new DescribeCertificateCommand({
          CertificateArn: certificateArn
        })
      );

      record =
        describe.Certificate
          .DomainValidationOptions?.[0]
          ?.ResourceRecord;

      if (record) break;

      await sleep(3000);
    }

    if (!record) {
      return response(500, {
        success: false,
        message: "ACM validation record not ready"
      });
    }

    /* ------------------------------
       3️⃣ Save certificate to DB
    ------------------------------ */

    await dynamoDbClient.send(
      new UpdateCommand({
        TableName: SITE_TABLE,
        Key: { userId, siteId },
        UpdateExpression:
          "SET certificateArn=:arn, certStatus=:status, requestedDomain=:domain, updatedAt=:updatedAt",
        ExpressionAttributeValues: {
          ":arn": certificateArn,
          ":status": "PENDING_VALIDATION",
          ":domain": normalizedDomain,
          ":updatedAt": new Date().toISOString()
        }
      })
    );

    /* ------------------------------
       4️⃣ Auto DNS (if possible)
    ------------------------------ */

    if (hostedZoneId) {

      try {

        await route53.send(
          new ChangeResourceRecordSetsCommand({
            HostedZoneId: hostedZoneId,
            ChangeBatch: {
              Changes: [
                {
                  Action: "UPSERT",
                  ResourceRecordSet: {
                    Name: record.Name,
                    Type: record.Type,
                    TTL: 300,
                    ResourceRecords: [
                      { Value: record.Value }
                    ]
                  }
                }
              ]
            }
          })
        );

        return response(200, {
          success: true,
          certificateArn,
          validationMethod: "AUTO",
          message: "DNS validation record created automatically"
        });

      }
      catch (err) {

        console.warn("Auto DNS failed:", err.message);

        return response(200, {
          success: true,
          certificateArn,
          validationMethod: "MANUAL",
          dnsRecord: {
            name: record.Name,
            type: record.Type,
            value: record.Value
          }
        });

      }

    }

    /* ------------------------------
       5️⃣ Manual DNS
    ------------------------------ */

    return response(200, {
      success: true,
      certificateArn,
      validationMethod: "MANUAL",
      dnsRecord: {
        name: record.Name,
        type: record.Type,
        value: record.Value
      }
    });

  }
  catch (err) {

    console.error("Domain setup error:", err);

    return response(500, {
      success: false,
      error: err.message
    });

  }

};