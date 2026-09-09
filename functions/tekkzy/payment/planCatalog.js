/**
 * Shared Tekkzy hosting / domain subscription catalog (INR + Razorpay).
 * Live plan IDs come from env (created in Razorpay dashboard / API).
 */

const MONTHLY_PLAN_ID = String(process.env.RAZORPAY_PLAN_ID_MONTHLY || "").trim();
const YEARLY_PLAN_ID = String(process.env.RAZORPAY_PLAN_ID_YEARLY || "").trim();

const PLAN_CATALOG = {
  hosting: {
    "hosting-monthly": {
      name: "Tekkzy Domain Hosting — Monthly",
      period: "monthly",
      interval: 1,
      totalCount: 120,
      razorpayPlanId: MONTHLY_PLAN_ID || null,
      amountByCurrency: {
        INR: 99,
        USD: 1,
      },
    },
    "hosting-yearly": {
      name: "Tekkzy Domain Hosting — Yearly",
      period: "yearly",
      interval: 1,
      totalCount: 10,
      razorpayPlanId: YEARLY_PLAN_ID || null,
      amountByCurrency: {
        INR: 999,
        USD: 12,
      },
    },
    // Legacy alias → monthly
    "hosting-standard": {
      name: "Tekkzy Domain Hosting — Monthly",
      period: "monthly",
      interval: 1,
      totalCount: 120,
      razorpayPlanId: MONTHLY_PLAN_ID || null,
      amountByCurrency: {
        INR: 99,
        USD: 1,
      },
    },
  },
  "domain-registration": {
    "domain-registration": {
      name: "Tekkzy Domain Registration",
      period: "yearly",
      interval: 1,
      totalCount: 10,
      razorpayPlanId: YEARLY_PLAN_ID || null,
      amountByCurrency: {
        INR: 999,
        USD: 12,
      },
    },
  },
};

const resolveHostingPlanId = (billingCycle) => {
  const cycle = String(billingCycle || "")
    .toLowerCase()
    .trim();
  if (cycle === "yearly" || cycle === "year" || cycle === "annual") {
    return "hosting-yearly";
  }
  return "hosting-monthly";
};

const getPlanFromCatalog = (paymentType, planId) =>
  PLAN_CATALOG[paymentType]?.[planId] || null;

module.exports = {
  PLAN_CATALOG,
  MONTHLY_PLAN_ID,
  YEARLY_PLAN_ID,
  resolveHostingPlanId,
  getPlanFromCatalog,
};
