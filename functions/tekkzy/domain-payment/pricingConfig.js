/**
 * Tekkzy domain-deploy pricing (INR / Razorpay).
 * Amounts are in major units (rupees). Razorpay APIs need paise (* 100).
 *
 * Live Razorpay plan IDs (prod):
 *   monthly → RAZORPAY_PLAN_ID_MONTHLY
 *   yearly  → RAZORPAY_PLAN_ID_YEARLY
 */

const GRACE_DAYS = Number(process.env.TEKKZY_DOMAIN_GRACE_DAYS || 7);

const MONTHLY_PLAN_ID = String(process.env.RAZORPAY_PLAN_ID_MONTHLY || "").trim();
const YEARLY_PLAN_ID = String(process.env.RAZORPAY_PLAN_ID_YEARLY || "").trim();

const makePlan = ({ amount, period, name, productPurchased, totalCount, razorpayPlanId }) => ({
  amount,
  currency: "INR",
  period,
  interval: 1,
  totalCount,
  name,
  productPurchased,
  razorpayPlanId: razorpayPlanId || null,
});

const PRICING = {
  subdomain: {
    monthly: makePlan({
      amount: 99,
      period: "monthly",
      totalCount: 120,
      name: "Tekkzy Domain Hosting — Monthly",
      productPurchased: "subdomain-monthly",
      razorpayPlanId: MONTHLY_PLAN_ID,
    }),
    yearly: makePlan({
      amount: 999,
      period: "yearly",
      totalCount: 10,
      name: "Tekkzy Domain Hosting — Yearly",
      productPurchased: "subdomain-yearly",
      razorpayPlanId: YEARLY_PLAN_ID,
    }),
  },
  custom: {
    monthly: makePlan({
      amount: 99,
      period: "monthly",
      totalCount: 120,
      name: "Tekkzy Domain Hosting — Monthly",
      productPurchased: "custom-domain-monthly",
      razorpayPlanId: MONTHLY_PLAN_ID,
    }),
    yearly: makePlan({
      amount: 999,
      period: "yearly",
      totalCount: 10,
      name: "Tekkzy Domain Hosting — Yearly",
      productPurchased: "custom-domain-yearly",
      razorpayPlanId: YEARLY_PLAN_ID,
    }),
  },
};

const normalizeDomainType = (domainType) => {
  const value = String(domainType || "")
    .toLowerCase()
    .trim();
  if (value === "subdomain") return "subdomain";
  if (value === "custom" || value === "customdomain" || value === "custom_domain") {
    return "custom";
  }
  return null;
};

const normalizeBillingCycle = (billingCycle) => {
  const value = String(billingCycle || "")
    .toLowerCase()
    .trim();
  if (value === "monthly" || value === "month") return "monthly";
  if (value === "yearly" || value === "year" || value === "annual") return "yearly";
  return null;
};

const getPlan = (domainType, billingCycle) => {
  const type = normalizeDomainType(domainType);
  const cycle = normalizeBillingCycle(billingCycle);
  if (!type || !cycle) return null;
  return PRICING[type]?.[cycle] || null;
};

const getRazorpayPlanIdForCycle = (billingCycle) => {
  const cycle = normalizeBillingCycle(billingCycle);
  if (cycle === "yearly") return YEARLY_PLAN_ID || null;
  if (cycle === "monthly") return MONTHLY_PLAN_ID || null;
  return null;
};

const listPricingForApi = () => ({
  subdomain: {
    monthly: PRICING.subdomain.monthly.amount,
    yearly: PRICING.subdomain.yearly.amount,
    currency: "INR",
  },
  customDomain: {
    monthly: PRICING.custom.monthly.amount,
    yearly: PRICING.custom.yearly.amount,
    currency: "INR",
  },
  graceDays: GRACE_DAYS,
});

const computeRenewDate = (fromEpochMs, billingCycle) => {
  const date = new Date(fromEpochMs || Date.now());
  if (normalizeBillingCycle(billingCycle) === "yearly") {
    date.setFullYear(date.getFullYear() + 1);
  } else {
    date.setMonth(date.getMonth() + 1);
  }
  return date.getTime();
};

const computeGraceEndsAt = (fromEpochMs = Date.now()) => {
  const date = new Date(fromEpochMs);
  date.setDate(date.getDate() + GRACE_DAYS);
  return date.getTime();
};

const ROOT_DOMAIN = "tekkzy.com";
const INSTITUTION = "tekkzy";
const DOMAIN_CLAIM_PK = "tekkzy#domain-claims";

module.exports = {
  PRICING,
  GRACE_DAYS,
  ROOT_DOMAIN,
  INSTITUTION,
  DOMAIN_CLAIM_PK,
  getPlan,
  getRazorpayPlanIdForCycle,
  listPricingForApi,
  normalizeDomainType,
  normalizeBillingCycle,
  computeRenewDate,
  computeGraceEndsAt,
};
