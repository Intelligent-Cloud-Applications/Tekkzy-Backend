/**
 * Restaurant Menu Management Handler (Tekkzy Multi-Tenant)
 * Scoped by {institution} (e.g. THEK6490)
 *
 * STORAGE:
 *   - Menu data (categories & items) → DynamoDB `code_generator_variables` in `us-east-1`
 *     Key: { institutionid: '<INSTITUTION>', index: '0' }
 *     Attributes: menuCategories (List), menuItems (List)
 *     ⚠️  Uses UpdateCommand (SET) so all other attributes (companyName, staffEmails, etc.)
 *         are 100% PRESERVED and NEVER HAMPERED.
 *   - Dish images → S3 `institution-utils` bucket in `us-east-1`
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  getS3ClientForRegion,
  PutObjectCommand,
  getSignedUrl,
} = require("../../../Utils/awsConfig");

const defaultSeed = require("./default-menu.json");

const MENU_TABLE = "code_generator_variables";
const MENU_REGION = "us-east-1"; // code_generator_variables is in us-east-1
const BUCKET = process.env.TEMPLATE_ASSETS_BUCKET || "institution-utils";
const BUCKET_REGION = process.env.TEMPLATE_ASSETS_BUCKET_REGION || "us-east-1";

// Dedicated DynamoDB document client pointing to us-east-1 for code_generator_variables
const ddbRawClient = new DynamoDBClient({ region: MENU_REGION });
const dynamoDB = DynamoDBDocumentClient.from(ddbRawClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  unmarshallOptions: { wrapNumbers: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Credentials": "true",
};

const sendResponse = (statusCode, body) => ({
  statusCode,
  headers: corsHeaders,
  body: JSON.stringify(body),
});

/* ────────────────────────────────────────────────────────
 *  DynamoDB helpers – read/write ONLY menuCategories & menuItems
 *  on the EXISTING index='0' row. All other attributes remain untouched.
 * ──────────────────────────────────────────────────────── */

/**
 * Load menu categories & items for an institution from DynamoDB.
 * Falls back to defaultSeed if the attributes don't exist yet.
 */
async function loadMenuData(institution) {
  try {
    const res = await dynamoDB.send(
      new GetCommand({
        TableName: MENU_TABLE,
        Key: { institutionid: institution, index: "0" },
        ProjectionExpression: "menuCategories, menuItems",
      })
    );

    const item = res.Item || {};
    const categories = item.menuCategories || null;
    const items = item.menuItems || null;

    // If neither attribute exists yet, seed defaults
    if (!categories && !items) {
      console.log(`[Menu] No menu data for ${institution}, seeding defaults`);
      await saveMenuData(institution, defaultSeed);
      return { ...defaultSeed };
    }

    return {
      categories: categories || [],
      items: items || [],
    };
  } catch (err) {
    console.error(`[Menu] DynamoDB read error for ${institution}:`, err);
    return { ...defaultSeed };
  }
}

/**
 * Save menu data using UpdateCommand (SET).
 * This ONLY writes menuCategories and menuItems —
 * every other attribute on the row (staffEmails, companyInfo, etc.) is left completely intact.
 */
async function saveMenuData(institution, data) {
  await dynamoDB.send(
    new UpdateCommand({
      TableName: MENU_TABLE,
      Key: { institutionid: institution, index: "0" },
      UpdateExpression: "SET menuCategories = :cats, menuItems = :items",
      ExpressionAttributeValues: {
        ":cats": data.categories || [],
        ":items": data.items || [],
      },
    })
  );
}

module.exports.main = async (event) => {
  const httpMethod = (event.httpMethod || "").toUpperCase();

  // Handle CORS preflight
  if (httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ message: "OK" }),
    };
  }

  try {
    const institution =
      event.pathParameters?.institution ||
      event.headers?.["x-institution-id"] ||
      "THEK6490";

    const path = event.path || "";
    const query = event.queryStringParameters || {};

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        body = {};
      }
    }

    // ── 1. STATS: GET /admin/dashboard/stats ──
    if (httpMethod === "GET" && path.includes("/admin/dashboard/stats")) {
      const data = await loadMenuData(institution);
      const items = data.items || [];
      const categories = data.categories || [];

      const stats = {
        totalItems: items.length,
        totalCategories: categories.length,
        publishedItems: items.filter((i) => i.publicationStatus === "published").length,
        availableItems: items.filter((i) => i.isAvailable !== false).length,
        featuredItems: items.filter((i) => Boolean(i.isFeatured)).length,
        lowStockItems: 0,
      };

      return sendResponse(200, { success: true, data: stats });
    }

    // ── 2. UPLOADS: POST /admin/uploads/presign ──
    if (
      httpMethod === "POST" &&
      (path.includes("/admin/uploads/presign") || path.includes("/admin/upload/presign"))
    ) {
      const { filename, fileType = "image/jpeg", folder = "dishes" } = body;
      if (!filename) {
        return sendResponse(400, { success: false, error: "filename is required" });
      }

      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `${institution}/${folder}/${Date.now()}-${safeName}`;
      const s3 = getS3ClientForRegion(BUCKET_REGION);

      const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: fileType,
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
      const publicUrl = `https://${BUCKET}.s3.${BUCKET_REGION}.amazonaws.com/${key}`;

      return sendResponse(200, {
        success: true,
        data: {
          uploadUrl,
          fileKey: key,
          publicUrl,
        },
      });
    }

    // ── 3. CATEGORIES ──
    if (path.includes("/menu/categories")) {
      const data = await loadMenuData(institution);
      let categories = data.categories || [];

      // GET Categories (Admin or Public)
      if (httpMethod === "GET") {
        const idMatch = path.match(/\/categories\/([^/?]+)/);
        if (idMatch) {
          const catId = decodeURIComponent(idMatch[1]);
          const cat = categories.find((c) => c.id === catId || c.slug === catId);
          if (!cat) {
            return sendResponse(404, { success: false, error: "Category not found" });
          }
          return sendResponse(200, { success: true, data: cat });
        }

        const isAdmin = path.includes("/admin/");
        const result = isAdmin
          ? [...categories].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
          : categories.filter((c) => c.isActive !== false).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

        return sendResponse(200, { success: true, data: result, items: result });
      }

      // POST Create Category
      if (httpMethod === "POST") {
        const newCat = {
          id: `cat-${Date.now()}`,
          name: body.name || "New Category",
          slug: body.slug || (body.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          description: body.description || "",
          imageUrl: body.imageUrl || "/dishes/starters.jpg",
          isActive: body.isActive !== false,
          sortOrder: body.sortOrder || categories.length + 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        categories.push(newCat);
        data.categories = categories;
        await saveMenuData(institution, data);
        return sendResponse(201, { success: true, data: newCat, message: "Category created" });
      }

      // PUT Update Category
      if (httpMethod === "PUT") {
        const idMatch = path.match(/\/categories\/([^/?]+)/);
        const catId = idMatch ? decodeURIComponent(idMatch[1]) : body.id;
        const index = categories.findIndex((c) => c.id === catId);
        if (index === -1) {
          return sendResponse(404, { success: false, error: "Category not found" });
        }
        categories[index] = {
          ...categories[index],
          ...body,
          updatedAt: new Date().toISOString(),
        };
        data.categories = categories;
        await saveMenuData(institution, data);
        return sendResponse(200, { success: true, data: categories[index], message: "Category updated" });
      }

      // PATCH Category Status
      if (httpMethod === "PATCH") {
        const idMatch = path.match(/\/categories\/([^/?]+)/);
        const catId = idMatch ? decodeURIComponent(idMatch[1]) : body.id;
        const index = categories.findIndex((c) => c.id === catId);
        if (index === -1) {
          return sendResponse(404, { success: false, error: "Category not found" });
        }
        if (body.isActive !== undefined) {
          categories[index].isActive = Boolean(body.isActive);
        }
        categories[index].updatedAt = new Date().toISOString();
        data.categories = categories;
        await saveMenuData(institution, data);
        return sendResponse(200, { success: true, data: categories[index] });
      }

      // DELETE Category
      if (httpMethod === "DELETE") {
        const idMatch = path.match(/\/categories\/([^/?]+)/);
        const catId = idMatch ? decodeURIComponent(idMatch[1]) : body.id;
        data.categories = categories.filter((c) => c.id !== catId);
        await saveMenuData(institution, data);
        return sendResponse(200, { success: true, message: "Category deleted" });
      }
    }

    // ── 4. MENU ITEMS ──
    if (path.includes("/menu/items")) {
      const data = await loadMenuData(institution);
      let items = data.items || [];

      // Specific Item Actions
      const idMatch = path.match(/\/items\/([^/?]+)/);
      const itemId = idMatch ? decodeURIComponent(idMatch[1]) : null;

      // PATCH Publish Status
      if (httpMethod === "PATCH" && path.includes("/publish")) {
        const index = items.findIndex((i) => i.id === itemId);
        if (index === -1) {
          return sendResponse(404, { success: false, error: "Item not found" });
        }
        const status = body.publicationStatus || (body.isPublished ? "published" : "draft");
        items[index].publicationStatus = status;
        items[index].updatedAt = new Date().toISOString();
        data.items = items;
        await saveMenuData(institution, data);
        return sendResponse(200, { success: true, data: items[index] });
      }

      // PATCH Availability
      if (httpMethod === "PATCH" && path.includes("/availability")) {
        const index = items.findIndex((i) => i.id === itemId);
        if (index === -1) {
          return sendResponse(404, { success: false, error: "Item not found" });
        }
        items[index].isAvailable = Boolean(body.isAvailable);
        items[index].updatedAt = new Date().toISOString();
        data.items = items;
        await saveMenuData(institution, data);
        return sendResponse(200, { success: true, data: items[index] });
      }

      // GET Single Item
      if (httpMethod === "GET" && itemId) {
        const item = items.find((i) => i.id === itemId || i.slug === itemId);
        if (!item) {
          return sendResponse(404, { success: false, error: "Item not found" });
        }
        return sendResponse(200, { success: true, data: item });
      }

      // PUT Update Item
      if (httpMethod === "PUT" && itemId) {
        const index = items.findIndex((i) => i.id === itemId);
        if (index === -1) {
          return sendResponse(404, { success: false, error: "Item not found" });
        }
        items[index] = {
          ...items[index],
          ...body,
          updatedAt: new Date().toISOString(),
        };
        data.items = items;
        await saveMenuData(institution, data);
        return sendResponse(200, { success: true, data: items[index], message: "Item updated" });
      }

      // DELETE Item
      if (httpMethod === "DELETE" && itemId) {
        data.items = items.filter((i) => i.id !== itemId);
        await saveMenuData(institution, data);
        return sendResponse(200, { success: true, message: "Item deleted" });
      }

      // POST Create Item
      if (httpMethod === "POST") {
        const newItem = {
          id: `dish-${Date.now()}`,
          name: body.name || "New Dish",
          categoryId: body.categoryId || "cat-main-course",
          categoryName: body.categoryName || "Main Course",
          price: Number(body.price || 0),
          halfPrice: body.halfPrice ? Number(body.halfPrice) : undefined,
          shortDescription: body.shortDescription || "",
          detailedDescription: body.detailedDescription || "",
          dietaryType: body.dietaryType || "veg",
          imageUrl: body.imageUrl || "/hero-dish-dark.jpg",
          additionalImages: Array.isArray(body.additionalImages) ? body.additionalImages : [],
          videoUrl: body.videoUrl || "",
          ingredients: Array.isArray(body.ingredients) ? body.ingredients : [],
          allergens: Array.isArray(body.allergens) ? body.allergens : [],
          isFeatured: Boolean(body.isFeatured),
          isAvailable: body.isAvailable !== false,
          publicationStatus: body.publicationStatus || "published",
          sortOrder: body.sortOrder || items.length + 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        items.push(newItem);
        data.items = items;
        await saveMenuData(institution, data);
        return sendResponse(201, { success: true, data: newItem, message: "Item created" });
      }

      // GET List Items
      if (httpMethod === "GET") {
        const isAdmin = path.includes("/admin/");
        let filtered = [...items];

        if (!isAdmin) {
          filtered = filtered.filter((i) => i.publicationStatus === "published");
        }

        if (query.category && query.category !== "all") {
          filtered = filtered.filter(
            (i) =>
              i.categoryId === query.category ||
              i.categoryName?.toLowerCase() === query.category.toLowerCase()
          );
        }

        if (query.dietary && query.dietary !== "all") {
          filtered = filtered.filter((i) => i.dietaryType === query.dietary);
        }

        if (query.search) {
          const s = query.search.toLowerCase().trim();
          filtered = filtered.filter(
            (i) =>
              i.name?.toLowerCase().includes(s) ||
              i.shortDescription?.toLowerCase().includes(s) ||
              i.categoryName?.toLowerCase().includes(s)
          );
        }

        filtered.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

        const page = query.page ? parseInt(query.page, 10) : 1;
        const limit = query.limit ? parseInt(query.limit, 10) : filtered.length || 50;

        return sendResponse(200, {
          success: true,
          data: filtered,
          items: filtered,
          meta: {
            total: filtered.length,
            page,
            limit,
          },
        });
      }
    }

    return sendResponse(404, { success: false, error: `Route not found: ${httpMethod} ${path}` });
  } catch (err) {
    console.error("[Menu Handler] Exception:", err);
    return sendResponse(500, { success: false, error: err.message || "Internal server error" });
  }
};
