const { GetCommand, DeleteCommand, dynamoDB } = require('../../Utils/awsConfig');
const { response } = require('../../Utils/Functions');

module.exports.main = async (event) => {
  try {
    let data = {};
    if (event.body) {
      try {
        data = JSON.parse(event.body);
      } catch {
        return response(400, { error: 'Invalid JSON in request body' });
      }
    }

    if (data.payload) {
      data = data.payload;
    }

    const templateId = String(data.templateId || '').trim();
    const templateNo =
      data.templateNo !== undefined && data.templateNo !== null
        ? String(data.templateNo).trim()
        : '';

    if (!templateId || !templateNo) {
      return response(400, {
        error: 'templateId and templateNo are required',
      });
    }

    const tableName = process.env.BETA_TEMPLATE_TABLE;
    if (!tableName) {
      return response(500, { error: 'BETA_TEMPLATE_TABLE is not configured' });
    }

    const key = { templateId, templateNo };

    const existing = await dynamoDB.send(
      new GetCommand({
        TableName: tableName,
        Key: key,
      })
    );

    if (!existing?.Item) {
      return response(404, { error: 'Template not found' });
    }

    await dynamoDB.send(
      new DeleteCommand({
        TableName: tableName,
        Key: key,
      })
    );

    return response(200, {
      success: true,
      message: 'Template deleted',
      templateId,
      templateNo,
      templateName: existing.Item.templateName || existing.Item.title || null,
    });
  } catch (err) {
    console.error('delete-template error', err);
    return response(500, {
      error: 'Failed to delete template',
      message: err.message,
    });
  }
};
