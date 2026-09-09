const { response } = require("../../../Utils/Functions");
const { listPricingForApi } = require("./pricingConfig");

module.exports.main = async () => {
  try {
    return response(200, {
      success: true,
      ...listPricingForApi(),
    });
  } catch (err) {
    console.error("getPricing error", err);
    return response(500, {
      success: false,
      message: "Unable to load pricing right now. Please try again.",
    });
  }
};
