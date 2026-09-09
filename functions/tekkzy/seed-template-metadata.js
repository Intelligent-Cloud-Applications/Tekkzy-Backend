const { GetCommand, PutCommand, UpdateCommand, dynamoDB } = require('../../Utils/awsConfig');
const { response } = require('../../Utils/Functions');

// Template metadata to seed
const TEMPLATE_METADATA = [
  {
    "templateId": "CLINIC",
    "templateNo": "1",
    "templateType": "eye",
    "templateName": "Doctor Service Theme",
    "domainUrl": "https://templateds.tekkzy.com",
    "category": "Doctor Service",
    "gradient": "from-blue-400 to-cyan-500",
    "icon": "FaStethoscope",
    "thumbnail": "/images/templates/ds.png"
  },
  {
    "templateId": "RESORT",
    "templateNo": "1",
    "templateType": "resort",
    "templateName": "Resort Theme",
    "domainUrl": "https://templaters.tekkzy.com",
    "category": "Resort",
    "gradient": "from-teal-500 to-cyan-600",
    "icon": "FaUmbrellaBeach",
    "thumbnail": "/images/templates/rs.png"
  },
  {
    "templateId": "HOTEL",
    "templateNo": "1",
    "templateType": "hotel",
    "templateName": "Hotel Management Theme",
    "domainUrl": "https://templatehm.tekkzy.com",
    "category": "Hotel Management",
    "gradient": "from-emerald-500 to-green-700",
    "icon": "FaHotel",
    "thumbnail": "/images/templates/hm.png"
  },
  {
    "templateId": "EDUCATION",
    "templateNo": "1",
    "templateType": "kid",
    "templateName": "Education Theme 4",
    "domainUrl": "https://templateed3.tekkzy.com",
    "category": "Education",
    "gradient": "from-blue-600 to-indigo-700",
    "icon": "FaGraduationCap",
    "thumbnail": "/images/templates/ed4.png"
  },
  {
    "templateId": "EDUCATION",
    "templateNo": "2",
    "templateType": "college",
    "templateName": "Education Theme 3",
    "domainUrl": "https://templateed2.tekkzy.com",
    "category": "Education",
    "gradient": "from-blue-600 to-indigo-700",
    "icon": "FaGraduationCap",
    "thumbnail": "/images/templates/ed3.png"
  },
  {
    "templateId": "EDUCATION",
    "templateNo": "3",
    "templateType": "school",
    "templateName": "Education Theme 2",
    "domainUrl": "https://templateed1.tekkzy.com",
    "category": "Education",
    "gradient": "from-blue-600 to-indigo-700",
    "icon": "FaGraduationCap",
    "thumbnail": "/images/templates/ed2.png"
  },
  {
    "templateId": "RESTAURANT",
    "templateNo": "1",
    "templateType": "cafe",
    "templateName": "Cafe Management Theme 1",
    "domainUrl": "https://templatecf.tekkzy.com",
    "category": "Cafe Management",
    "gradient": "from-amber-600 to-orange-700",
    "icon": "FaCoffee",
    "thumbnail": "/images/templates/cf1.png"
  },
  {
    "templateId": "RESTAURANT",
    "templateNo": "2",
    "templateType": "cafe",
    "templateName": "Cafe Management Theme 2",
    "domainUrl": "https://templatecf1.tekkzy.com",
    "category": "Cafe Management",
    "gradient": "from-amber-600 to-orange-700",
    "icon": "FaCoffee",
    "thumbnail": "/images/templates/cf2.png"
  },
  {
    "templateId": "SALON",
    "templateNo": "1",
    "templateType": "salon",
    "templateName": "Salon Theme",
    "domainUrl": "https://templatesalon2.tekkzy.com",
    "category": "Salon Management",
    "gradient": "from-pink-500 to-rose-600",
    "icon": "FaCut",
    "thumbnail": "/images/templates/salon.png"
  },
  {
    "templateId": "ENTERPRISE",
    "templateNo": "1",
    "templateType": "furniture",
    "templateName": "Enterprise Theme 3",
    "domainUrl": "https://templateep2.tekkzy.com",
    "category": "Enterprise",
    "gradient": "from-gray-600 to-gray-800",
    "icon": "FaBuilding",
    "thumbnail": "/images/templates/ep3.png"
  },
  {
    "templateId": "ENTERPRISE",
    "templateNo": "2",
    "templateType": "fashion",
    "templateName": "Enterprise Theme 2",
    "domainUrl": "https://templateep1.tekkzy.com",
    "category": "Enterprise",
    "gradient": "from-gray-600 to-gray-800",
    "icon": "FaBuilding",
    "thumbnail": "/images/templates/ep2.png"
  },
  {
    "templateId": "ENTERPRISE",
    "templateNo": "3",
    "templateType": "fashion",
    "templateName": "Enterprise Theme 1",
    "domainUrl": "https://templateep.tekkzy.com",
    "category": "Enterprise",
    "gradient": "from-gray-600 to-gray-800",
    "icon": "FaBuilding",
    "thumbnail": "/images/templates/ep1.png"
  }
];

module.exports.main = async (event) => {
    try {
        const results = {
            upserted: 0,
            updated: 0,
            created: 0,
            failed: 0,
            errors: []
        };

        for (const template of TEMPLATE_METADATA) {
            try {
                const templateNoStr = String(template.templateNo);
                const key = { templateId: template.templateId, templateNo: templateNoStr };

                // Check if template exists
                const getParams = {
                    TableName: process.env.BETA_TEMPLATE_TABLE,
                    Key: key
                };

                const existing = await dynamoDB.send(new GetCommand(getParams));

                // Fields to upsert
                const metadataFields = {
                    domainUrl: template.domainUrl,
                    category: template.category,
                    gradient: template.gradient,
                    icon: template.icon,
                    thumbnail: template.thumbnail
                };

                if (existing && existing.Item) {
                    // Update existing template with metadata fields
                    const updatedItem = {
                        ...existing.Item,
                        ...metadataFields,
                        updatedAt: new Date().toISOString()
                    };

                    const putParams = {
                        TableName: process.env.BETA_TEMPLATE_TABLE,
                        Item: updatedItem
                    };

                    await dynamoDB.send(new PutCommand(putParams));
                    results.updated++;
                } else {
                    // Create new template with metadata
                    const newItem = {
                        templateId: template.templateId,
                        templateNo: templateNoStr,
                        templateType: template.templateType,
                        templateName: template.templateName,
                        ...metadataFields,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };

                    const putParams = {
                        TableName: process.env.BETA_TEMPLATE_TABLE,
                        Item: newItem
                    };

                    await dynamoDB.send(new PutCommand(putParams));
                    results.created++;
                }

                results.upserted++;
            } catch (err) {
                results.failed++;
                results.errors.push({
                    template: `${template.templateId}-${template.templateNo}`,
                    error: err.message
                });
                console.error(`Error upserting template ${template.templateId}-${template.templateNo}:`, err.message);
            }
        }

        return response(200, {
            message: 'Template metadata seeding completed',
            ...results
        });

    } catch (err) {
        console.error('seed-template-metadata error:', err);
        return response(500, {
            error: err.message || 'Internal Server Error'
        });
    }
};
