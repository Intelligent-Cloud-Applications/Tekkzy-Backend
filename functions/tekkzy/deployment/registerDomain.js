const {
  Route53DomainsClient,
  RegisterDomainCommand
} = require("@aws-sdk/client-route-53-domains");

const {
  dynamoDbClient
} = require("../../../Utils/awsConfig");

const {
  UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const crypto = require("crypto");

const client = new Route53DomainsClient({ region: "us-east-1" });

module.exports.main = async (event) => {

  try {

    const body = JSON.parse(event.body || {});
    const cognitoId = event.requestContext.identity.cognitoIdentityId;

    const {
      domain,
      email,
      firstName,
      lastName,
      phone,
      address,
      city,
      state,
      country,
      zip
    } = body;

    if (!domain) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          success: false,
          message: "domain required"
        })
      };
    }

    /* ---------- Contact Object ---------- */

    const contact = {
      FirstName: firstName,
      LastName: lastName,
      ContactType: "PERSON",
      Email: email,
      PhoneNumber: phone,
      AddressLine1: address,
      City: city,
      State: state,
      CountryCode: country,
      ZipCode: zip
    };

    /* ---------- Register Domain ---------- */

    const command = new RegisterDomainCommand({
      DomainName: domain,
      DurationInYears: 1,

      AdminContact: contact,
      RegistrantContact: contact,
      TechContact: contact,

      PrivacyProtectAdminContact: true,
      PrivacyProtectRegistrantContact: true,
      PrivacyProtectTechContact: true,

      AutoRenew: true,
      IdempotencyToken: crypto.randomUUID()
    });

    const result = await client.send(command);

    /* ---------- Save Domain In Profile ---------- */

    await dynamoDbClient.send(
      new UpdateCommand({
        TableName: process.env.PROFILE_TABLE_NAME,
        Key: {
          institution: "tekkzy",
          cognitoId
        },
        UpdateExpression:
          "SET domains = list_append(if_not_exists(domains, :empty), :newDomain), updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":empty": [],
          ":newDomain": [
            {
              domain,
              operationId: result.OperationId,
              status: "REGISTERING",
              autoRenew: true,
              createdAt: new Date().toISOString()
            }
          ],
          ":updatedAt": new Date().toISOString()
        }
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        operationId: result.OperationId,
        message: "Domain registration started"
      })
    };

  } catch (err) {

    console.error("Register domain error:", err);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message
      })
    };

  }

};