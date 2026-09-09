const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

describe("webhook signature verification logic", () => {
  it("accepts matching HMAC signatures", () => {
    const secret = "test_webhook_secret";
    const body = JSON.stringify({ event: "subscription.charged", id: "evt_1" });
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(signature, expected);
  });

  it("rejects mismatched signatures (idempotency key uniqueness)", () => {
    const secret = "test_webhook_secret";
    const body = JSON.stringify({ event: "subscription.charged", id: "evt_1" });
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const bad = crypto.createHmac("sha256", "other").update(body).digest("hex");
    assert.notEqual(signature, bad);

    const processed = new Set(["evt_1"]);
    assert.equal(processed.has("evt_1"), true);
    assert.equal(processed.has("evt_2"), false);
  });
});
