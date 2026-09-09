const { dynamoDB, ScanCommand } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");

module.exports.main = async (event) => {
  try {
    const cognitoId = event?.requestContext?.identity?.cognitoIdentityId;

    if (!cognitoId) {
      return response(401, {
        success: false,
        message: "Unauthorized: cognitoId not found in request context",
      });
    }

    const result = await dynamoDB.send(
      new ScanCommand({
        TableName: process.env.PAYMENT_TABLE_NAME,
        FilterExpression: "cognitoId = :cognitoId AND institution = :institution",
        ExpressionAttributeValues: {
          ":cognitoId": String(cognitoId),
          ":institution": "tekkzy",
        },
      })
    );

    const payments = Array.isArray(result?.Items) ? result.Items : [];
    const sortedPayments = payments.sort(
      (a, b) => Number(b?.paymentDate || 0) - Number(a?.paymentDate || 0)
    );

    return response(200, {
      success: true,
      payments: sortedPayments,
    });
  } catch (error) {
    return response(500, {
      success: false,
      error: error.message,
    });
  }
};
