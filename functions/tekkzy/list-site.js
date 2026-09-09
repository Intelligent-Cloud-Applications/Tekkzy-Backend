const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { dynamoDbClient } = require("../../Utils/awsConfig");
const { response } = require("../../Utils/Functions");

const SITE_TABLE = process.env.SITE_TABLE;

module.exports.main = async (event) => {
  try {

    const userId = event.requestContext.identity.cognitoIdentityId;

    if (!userId) {
      return response(401, {
        success: false,
        message: "Unauthorized"
      });
    }

    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: SITE_TABLE,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId
        }
      })
    );

    return response(200, {
      success: true,
      sites: result.Items || []
    });

  } catch (err) {

    console.error("List sites error:", err);

    return response(500, {
      success: false,
      error: err.message
    });

  }
};