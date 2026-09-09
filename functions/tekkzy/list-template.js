const { ScanCommand, dynamoDB } = require('../../Utils/awsConfig');
const { response } = require('../../Utils/Functions');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_SCAN_PAGES = 12;

function encodeCursor(key) {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return undefined;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    try {
      // Fallback for older base64 encodings
      const json = Buffer.from(cursor, 'base64').toString('utf8');
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  }
}

function parseLimit(raw) {
  const n = parseInt(String(raw ?? DEFAULT_LIMIT), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function normalizeCategoryKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function matchesSearch(item, search) {
  if (!search) return true;
  const blob = [
    item.templateName,
    item.title,
    item.description,
    item.category,
    item.templateType,
    item.domainUrl,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return blob.includes(search);
}

async function collectCategories(tableName) {
  const names = new Set();
  let startKey;

  do {
    const params = {
      TableName: tableName,
      ProjectionExpression: '#cat, templateType, categoryKey',
      ExpressionAttributeNames: { '#cat': 'category' },
    };
    if (startKey) params.ExclusiveStartKey = startKey;

    const result = await dynamoDB.send(new ScanCommand(params));
    (result.Items || []).forEach((item) => {
      const label =
        (item.category && String(item.category).trim()) ||
        (item.templateType && String(item.templateType).trim()) ||
        '';
      if (label) names.add(label);
    });
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * GET /list-templates
 * Query:
 *   limit            — page size (default 10, max 50)
 *   cursor|nextToken — opaque pagination cursor
 *   category         — filter by category / templateType (case-insensitive)
 *   search           — free-text filter on name/description/category
 *   includeCategories — "1"/"true" to also return distinct category labels
 */
module.exports.main = async (event) => {
  try {
    const tableName = process.env.BETA_TEMPLATE_TABLE;
    if (!tableName) {
      return response(500, { error: 'BETA_TEMPLATE_TABLE is not configured' });
    }

    const qs = event.queryStringParameters || {};
    const limit = parseLimit(qs.limit);
    const categoryRaw = String(qs.category || '').trim();
    const categoryKey = normalizeCategoryKey(categoryRaw);
    const search = String(qs.search || '')
      .trim()
      .toLowerCase();
    const includeCategories =
      qs.includeCategories === '1' ||
      qs.includeCategories === 'true' ||
      qs.includeCategories === 'yes';

    let exclusiveStartKey = decodeCursor(qs.cursor || qs.nextToken);
    const collected = [];
    let lastEvaluatedKey = exclusiveStartKey;
    let pages = 0;

    while (collected.length < limit && pages < MAX_SCAN_PAGES) {
      const pageLimit = Math.min(
        50,
        Math.max(limit - collected.length, Math.ceil(limit * 1.5)),
      );

      const params = {
        TableName: tableName,
        Limit: pageLimit,
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      // Prefer categoryKey (normalized on write). Fall back to category / templateType
      // for older rows that predate categoryKey.
      if (categoryKey && categoryKey !== 'all') {
        params.FilterExpression =
          'categoryKey = :ck OR #cat = :clabel OR templateType = :clabel OR #cat = :ck OR templateType = :ck';
        params.ExpressionAttributeNames = { '#cat': 'category' };
        params.ExpressionAttributeValues = {
          ':ck': categoryKey,
          ':clabel': categoryRaw,
        };
      }

      const result = await dynamoDB.send(new ScanCommand(params));
      let items = result.Items || [];

      if (search) {
        items = items.filter((item) => matchesSearch(item, search));
      }

      for (const item of items) {
        collected.push(item);
        if (collected.length >= limit) break;
      }

      lastEvaluatedKey = result.LastEvaluatedKey;
      pages += 1;
      if (!lastEvaluatedKey) break;
    }

    // Newest first when createdAt is present
    collected.sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '') || 0;
      const bTime = Date.parse(b.createdAt || '') || 0;
      return bTime - aTime;
    });

    const payload = {
      items: collected,
      count: collected.length,
      limit,
      hasMore: Boolean(lastEvaluatedKey),
      nextCursor: encodeCursor(lastEvaluatedKey),
      category: categoryRaw || null,
    };

    if (includeCategories) {
      try {
        payload.categories = await collectCategories(tableName);
      } catch (catErr) {
        console.warn('list-templates categories scan failed', catErr.message);
        payload.categories = [];
      }
    }

    // Always 200 — empty list is a valid page (never 404).
    return response(200, payload);
  } catch (err) {
    console.log('list-templates error', err);
    return response(500, {
      error: err.message || 'Internal Server Error',
    });
  }
};
