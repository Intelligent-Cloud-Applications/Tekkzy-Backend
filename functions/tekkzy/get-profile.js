const { GetCommand, dynamoDB } = require('../../Utils/awsConfig');
const { response } = require('../../Utils/Functions');

module.exports.main = async (event) => {
  try {
    // Accept body JSON or query string parameters
    let data = {};
    if (event.body) {
      try {
        data = JSON.parse(event.body);
      } catch (e) {
        data = event.body;
      }
    } else if (event.queryStringParameters) {
      data = { ...event.queryStringParameters };
    }

    // Try to extract Cognito id from request context or provided data
    const ctxCognitoId =
      event?.requestContext?.identity?.cognitoIdentityId;

    const cognitoId = ctxCognitoId || data.cognitoId || data.sub || data.id;
    const institution = event?.pathParameters?.institution || data?.institution || 'tekkzy';

    if (!cognitoId) {
      return response(400, { error: 'cognitoId is required (from requestContext, authorizer claims, or request body/query).' });
    }

    const params = {
      TableName: process.env.PROFILE_TABLE_NAME,
      Key: { institution, cognitoId },
    };

    const result = await dynamoDB.send(new GetCommand(params));

    if (!result || !result.Item) {
      return response(404, { error: 'Profile not found' });
    }

    return response(200, { item: result.Item });
  } catch (err) {
    console.log('get-profile error', err);
    return response(500, { error: err.message || 'Internal Server Error' });
  }
};
