const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateSubdomainName,
  validateCustomDomain,
} = require("../validators");
const { listPricingForApi, getPlan } = require("../pricingConfig");

describe("validateSubdomainName", () => {
  it("rejects empty", () => {
    assert.equal(validateSubdomainName("").ok, false);
  });

  it("rejects single character", () => {
    assert.equal(validateSubdomainName("ab").ok, false);
  });

  it("rejects too long", () => {
    assert.equal(validateSubdomainName("a".repeat(64)).ok, false);
  });

  it("normalizes uppercase", () => {
    const result = validateSubdomainName("MyBrand");
    assert.equal(result.ok, true);
    assert.equal(result.name, "mybrand");
  });

  it("rejects special characters", () => {
    assert.equal(validateSubdomainName("my_brand").ok, false);
    assert.equal(validateSubdomainName("my.brand").ok, false);
  });

  it("rejects leading/trailing hyphens", () => {
    assert.equal(validateSubdomainName("-mybrand").ok, false);
    assert.equal(validateSubdomainName("mybrand-").ok, false);
  });

  it("rejects reserved words", () => {
    assert.equal(validateSubdomainName("www").ok, false);
    assert.equal(validateSubdomainName("admin").ok, false);
    assert.equal(validateSubdomainName("api").ok, false);
  });

  it("accepts valid names", () => {
    assert.equal(validateSubdomainName("my-brand").ok, true);
    assert.equal(validateSubdomainName("shop123").ok, true);
  });
});

describe("validateCustomDomain", () => {
  it("rejects missing TLD", () => {
    assert.equal(validateCustomDomain("mybrand").ok, false);
  });

  it("rejects spaces and protocol", () => {
    assert.equal(validateCustomDomain("my brand.com").ok, false);
    assert.equal(validateCustomDomain("https://mybrand.com").ok, false);
  });

  it("accepts valid domains", () => {
    const result = validateCustomDomain("MyBrand.com");
    assert.equal(result.ok, true);
    assert.equal(result.domain, "mybrand.com");
  });
});

describe("pricingConfig", () => {
  it("returns subdomain and customDomain pricing", () => {
    const pricing = listPricingForApi();
    assert.equal(pricing.subdomain.currency, "INR");
    assert.equal(pricing.subdomain.monthly, 99);
    assert.equal(pricing.subdomain.yearly, 999);
    assert.equal(pricing.customDomain.monthly, 99);
  });

  it("resolves plans", () => {
    const plan = getPlan("subdomain", "yearly");
    assert.equal(plan.productPurchased, "subdomain-yearly");
    assert.equal(plan.amount, 999);
  });
});
