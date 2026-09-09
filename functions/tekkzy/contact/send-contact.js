/**
 * Shared Contact Form handler for Tekkzy template sites.
 *
 * POST /tekkzy/contact
 *
 * Body:
 * {
 *   "fullName": "Jane Doe",
 *   "email": "jane@example.com",
 *   "phone": "+1-555-0100",
 *   "message": "Hello",
 *   ...any other form fields...
 *   "_meta": {
 *     "formName": "Tekkzy Resort Contact",
 *     "toEmail": "info@tekkzyresort.com",
 *     "replyTo": "jane@example.com",
 *     "ccEmail": "optional@example.com",
 *     "ignoreFields": ["_meta"],
 *     "customLabels": { "fullName": "Customer Name" }
 *   }
 * }
 */

const { sesClient, SendEmailCommand } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");

const DEFAULT_FROM_EMAIL =
  process.env.SES_FROM_EMAIL || "saibedamatta@happyprancer.com";
const DEFAULT_TO_EMAIL =
  process.env.QUERY_TO_EMAIL || "saibedamatta@happyprancer.com";
const DEFAULT_FORM_NAME = "Website Contact Form";

const STANDARD_LABEL_MAP = {
  name: "Name",
  fullName: "Full Name",
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  emailId: "Email Address",
  phone: "Phone",
  phoneNumber: "Phone Number",
  mobile: "Mobile",
  message: "Message",
  inquiry: "Inquiry",
  property: "Preferred Property",
  contactDate: "Preferred Contact Date",
  contactTime: "Preferred Contact Time",
  subject: "Subject",
  company: "Company",
  website: "Website",
  guests: "Guests",
  checkInDate: "Check-in Date",
  checkOutDate: "Check-out Date",
  agreePrivacy: "Agreed to Privacy Policy",
  source: "Form Source",
  submittedAt: "Submitted At",
  siteName: "Site Name",
  siteId: "Site ID",
};

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function keyToLabel(key) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getLabel(key, customLabels = {}) {
  if (customLabels[key]) return customLabels[key];
  if (STANDARD_LABEL_MAP[key]) return STANDARD_LABEL_MAP[key];
  return keyToLabel(key);
}

function normalizeValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) =>
        item === undefined || item === null ? "" : String(item).trim(),
      )
      .filter(Boolean);
    return cleaned.length > 0 ? cleaned.join(", ") : "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "[Object]";
    }
  }
  return String(value);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function formatDatetime(value) {
  if (!value) return value;
  if (typeof value === "string" && value.match(/^\d{4}-\d{2}-\d{2}/)) {
    try {
      return new Date(value).toLocaleDateString("en-IN", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return value;
    }
  }
  return value;
}

function buildSummaryTable(payload, ignoreFields = [], customLabels = {}) {
  const visibleEntries = Object.entries(payload)
    .filter(([key]) => !ignoreFields.includes(key))
    .map(([key, value]) => [
      key,
      normalizeValue(value),
      getLabel(key, customLabels),
    ])
    .filter(([, value]) => value !== "");

  if (!visibleEntries.length) {
    return "<p style=\"margin:0;font-size:14px;line-height:1.7;color:#4b5563;\">No details were provided in the form submission.</p>";
  }

  const rowMarkup = visibleEntries
    .map(
      ([, value, label], index) => `
            <tr>
              <td style="padding:14px 16px;${
                index < visibleEntries.length - 1
                  ? "border-bottom:1px solid #e5e7eb;"
                  : ""
              }font-size:13px;letter-spacing:0.02em;text-transform:uppercase;color:#6b7280;width:34%;vertical-align:top;"><strong>${escapeHtml(label)}</strong></td>
              <td style="padding:14px 16px;${
                index < visibleEntries.length - 1
                  ? "border-bottom:1px solid #e5e7eb;"
                  : ""
              }font-size:14px;color:#111827;line-height:1.7;vertical-align:top;word-break:break-word;white-space:pre-wrap;">${escapeHtml(formatDatetime(value))}</td>
            </tr>`,
    )
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(15, 23, 42, 0.08);">
${rowMarkup}
              </table>`;
}

function extractMetadata(payload) {
  const meta = payload._meta || {};
  const replyTo =
    meta.replyTo ||
    payload.email ||
    payload.emailId ||
    null;

  return {
    formName: meta.formName || DEFAULT_FORM_NAME,
    ignoreFields: Array.isArray(meta.ignoreFields)
      ? meta.ignoreFields
      : ["_meta"],
    customLabels: meta.customLabels || {},
    toEmail: meta.toEmail || meta.contactMail || DEFAULT_TO_EMAIL,
    ccEmail: meta.ccEmail || null,
    fromEmail: meta.fromEmail || DEFAULT_FROM_EMAIL,
    replyTo,
    timestamp: meta.timestamp || new Date().toISOString(),
  };
}

function buildEmailTemplate(payload, metadata) {
  const { formName, ignoreFields, customLabels, timestamp } = metadata;
  const summaryMarkup = buildSummaryTable(payload, ignoreFields, customLabels);

  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Form Submission: ${escapeHtml(formName)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 16px 40px rgba(15, 23, 42, 0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#111827,#1d4ed8);padding:28px 26px;">
                <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;letter-spacing:0.16em;text-transform:uppercase;color:#bfdbfe;">Tekkzy Contact Form</p>
                <h1 style="margin:0;font-size:26px;line-height:1.25;color:#ffffff;">${escapeHtml(formName)}</h1>
                <p style="margin:10px 0 0 0;font-size:14px;line-height:1.6;color:#dbeafe;">A visitor submitted a message from your website.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:26px;">
                <div style="margin:0 0 18px 0;padding:16px 18px;background:#eff6ff;border:1px solid #dbeafe;border-radius:14px;color:#1e3a8a;font-size:14px;line-height:1.7;">
                  <strong>Submission Details</strong><br/>
                  Only fields provided by the visitor are shown below.
                </div>
                ${summaryMarkup}
                <div style="margin:18px 0 0 0;padding:14px;background:#f3f4f6;border-radius:8px;font-size:12px;color:#6b7280;line-height:1.6;">
                  <strong>Metadata:</strong><br/>
                  Submitted: ${escapeHtml(timestamp)}<br/>
                  Form: ${escapeHtml(formName)}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 26px;background:#f9fafb;border-top:1px solid #e5e7eb;">
                <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;">
                  Automated notification from Tekkzy template contact handler. Reply to the visitor using Reply-To when available.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

module.exports.main = async (event) => {
  let payload;

  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return response(400, {
      success: false,
      error: "Invalid JSON in request body",
    });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return response(400, {
      success: false,
      error: "Request body must be a JSON object",
    });
  }

  const metadata = extractMetadata(payload);

  if (!isValidEmail(metadata.toEmail)) {
    console.error("Invalid TO email: " + metadata.toEmail);
    return response(400, {
      success: false,
      error: "Invalid recipient email. Pass _meta.toEmail from data.json site.contact.email / contactMail.",
    });
  }

  if (!isValidEmail(metadata.fromEmail)) {
    console.error("Invalid FROM email: " + metadata.fromEmail);
    return response(500, {
      success: false,
      error: "Invalid sender email configuration (SES_FROM_EMAIL)",
    });
  }

  const hasContent = Object.entries(payload).some(([key, value]) => {
    if (key === "_meta") return false;
    return normalizeValue(value) !== "";
  });

  if (!hasContent) {
    return response(400, {
      success: false,
      error: "Form submission is empty",
    });
  }

  const emailParams = {
    Source: metadata.fromEmail,
    Destination: {
      ToAddresses: [metadata.toEmail],
    },
    Message: {
      Subject: {
        Data: metadata.formName + " Submission",
        Charset: "UTF-8",
      },
      Body: {
        Html: {
          Data: buildEmailTemplate(payload, metadata),
          Charset: "UTF-8",
        },
      },
    },
    ReplyToAddresses:
      metadata.replyTo && isValidEmail(metadata.replyTo)
        ? [metadata.replyTo]
        : [],
  };

  if (metadata.ccEmail && isValidEmail(metadata.ccEmail)) {
    emailParams.Destination.CcAddresses = [metadata.ccEmail];
  }

  try {
    const result = await sesClient.send(new SendEmailCommand(emailParams));
    return response(200, {
      success: true,
      message: "Contact form submitted and email sent successfully",
      messageId: result.MessageId,
      formName: metadata.formName,
    });
  } catch (error) {
    console.error("Error sending contact form email:", error);
    return response(500, {
      success: false,
      error: "Failed to send email",
      details: error.message,
    });
  }
};