const { GetCommand, PutCommand, dynamoDB } = require('../../Utils/awsConfig');
const { response } = require('../../Utils/Functions');

module.exports.main = async (event) => {
  try {
    // Accept body JSON or query string parameters from frontend
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

    const email = data.email || data.emailId || (data.emailId && data.emailId.toString());
    const name = data.name || data.fullName || data.userName || data.username;

    const ctxCognitoId =
      event?.requestContext?.identity?.cognitoIdentityId;

    const cognitoId = ctxCognitoId || data.cognitoId;
    const institution = event?.pathParameters?.institution || data?.institution || 'tekkzy';

    if (!email || !cognitoId) {
      return response(400, { error: 'Both email and cognitoId are required.' });
    }

    const getParams = {
      TableName: process.env.PROFILE_TABLE_NAME,
      Key: { institution, cognitoId },
    };

    const existing = await dynamoDB.send(new GetCommand(getParams));
    if (existing && existing.Item) {
      return response(409, { error: 'User already exists', item: existing.Item });
    }

    // store all client-provided fields (unknown keys included) while enforcing institution and cognitoId
    const item = Object.assign({}, data, {
      institution,
      cognitoId,
      emailId: email,
      name,
      createdAt: new Date().toISOString(),
    });

    const putParams = {
      TableName: process.env.PROFILE_TABLE_NAME,
      Item: item,
    };

    await dynamoDB.send(new PutCommand(putParams));

    return response(201, { message: 'User created', item });
  } catch (err) {
    console.log('profile-create error', err);
    return response(500, { error: err.message || 'Internal Server Error' });
  }
};
