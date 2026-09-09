const { GetCommand, PutCommand, dynamoDB } = require('../../Utils/awsConfig');
const { response } = require('../../Utils/Functions');

module.exports.main = async (event) => {
  try {
    // Accept body JSON from frontend
    let data = {};
    if (event.body) {
      try {
        data = JSON.parse(event.body);
      } catch (e) {
        data = {};
      }
    }

    const { name, imgUrl, cognitoId: bodyCognitoId } = data;

    // Extract cognito id from request context or fallback to provided value
    const ctxCognitoId =
      event?.requestContext?.identity?.cognitoIdentityId;

    const cognitoId = ctxCognitoId || bodyCognitoId;
    const institution = 'tekkzy';

    if (!cognitoId) {
      return response(400, { error: 'cognitoId is required (from requestContext or body).' });
    }

    const getParams = {
      TableName: process.env.PROFILE_TABLE_NAME,
      Key: { institution, cognitoId },
    };

    const existing = await dynamoDB.send(new GetCommand(getParams));
    if (!existing || !existing.Item) {
      return response(404, { error: 'User not found' });
    }

    // Update requested profile fields
    const updatedItem = Object.assign({}, existing.Item, {
      institution,
      cognitoId,
      name: name ?? existing.Item.name,
      imgUrl: imgUrl ?? existing.Item.imgUrl,
      updatedAt: new Date().toISOString(),
    });

    const putParams = {
      TableName: process.env.PROFILE_TABLE_NAME,
      Item: updatedItem,
    };

    await dynamoDB.send(new PutCommand(putParams));

    return response(200, { message: 'Profile updated', item: updatedItem });
  } catch (err) {
    console.log('update-profile error', err);
    return response(500, { error: err.message || 'Internal Server Error' });
  }
};
