// netlify/functions/lead.js
// Secure server-side lead handler for the A-Z Global website.
// Receives JSON from any site form, upserts a HubSpot contact, and emails A-Z Global.
// SECRETS ARE READ FROM ENVIRONMENT VARIABLES ONLY — never hard-code them and never
// expose them in client HTML/JS. Configure these in Netlify > Site settings > Environment.
//
// Required env vars:
//   HUBSPOT_PRIVATE_APP_TOKEN   HubSpot private app token (CRM scopes: crm.objects.contacts.write/read)
//   RESEND_API_KEY              Transactional email provider key (Resend by default)
//   NOTIFY_EMAIL_TO             Destination inbox for lead notifications (e.g. info@a-zglobal.com)
//   NOTIFY_EMAIL_FROM           Verified sender (e.g. "A-Z Global Website <noreply@a-zglobal.com>")
// Optional:
//   ALLOWED_ORIGIN              CORS origin (defaults to "*"; set to https://www.a-zglobal.com)
//
// Node 18+ runtime (global fetch available). No npm dependencies required.

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_TO = process.env.NOTIFY_EMAIL_TO || "info@a-zglobal.com,zakaria.ayyad@a-zglobal.com"; // comma-separated
const NOTIFY_FROM = process.env.NOTIFY_EMAIL_FROM;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(statusCode, obj) {
  return { statusCode, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Map only STANDARD HubSpot contact properties here so the API never 400s on unknown
// fields. To push tool-specific extras (score, risk, exposure, domain scores) INTO HubSpot,
// first create matching custom properties in HubSpot, then add them to this object.
function hubspotProps(d) {
  const [firstname, ...rest] = String(d.name || "").trim().split(/\s+/);
  const props = {
    email: d.email || "",
    firstname: d.firstName || firstname || "",
    lastname: d.lastName || rest.join(" ") || "",
    company: d.company || d.org || "",
    jobtitle: d.jobtitle || d.role || d.title || "",
    country: d.country || "",
    phone: d.phone || "",
    lifecyclestage: "lead",
  };
  Object.keys(props).forEach((k) => { if (props[k] === "" || props[k] == null) delete props[k]; });
  return props;
}

async function upsertHubSpotContact(d) {
  if (!HUBSPOT_TOKEN) return { ok: false, skipped: "HUBSPOT_PRIVATE_APP_TOKEN not set" };
  const email = (d.email || "").trim();
  if (!email) return { ok: false, error: "no email — HubSpot contact needs an email" };
  const headers = { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" };
  const body = JSON.stringify({ properties: hubspotProps(d) });

  // Try create; if the contact already exists (409), update by email.
  let res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", { method: "POST", headers, body });
  if (res.status === 409) {
    res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`,
      { method: "PATCH", headers, body }
    );
  }
  if (!res.ok) return { ok: false, error: `HubSpot ${res.status}: ${await res.text()}` };
  return { ok: true };
}

function emailBody(d) {
  const line = (label, val) =>
    (val === undefined || val === null || val === "") ? "" : `${label}: ${val}\n`;
  let extra = "";
  if (d.assessmentType || d.toolSource) extra += line("Assessment / tool", d.assessmentType || d.toolSource);
  if (d.overallScore != null) extra += line("Overall score", d.overallScore);
  if (d.riskRating) extra += line("Risk rating", d.riskRating);
  if (d.estimatedExposure != null) extra += line("Estimated exposure", d.estimatedExposure);
  if (d.annualRevenue != null) extra += line("Annual revenue", d.annualRevenue);
  if (d.shrinkagePct != null) extra += line("Shrinkage %", d.shrinkagePct);
  if (d.region) extra += line("Region", d.region);
  if (d.locations != null) extra += line("Locations", d.locations);
  if (d.employees != null) extra += line("Employees", d.employees);
  if (d.revenue != null && d.annualRevenue == null) extra += line("Annual revenue", d.revenue);
  if (d.type) extra += line("Sector / operation type", d.type);
  if (d.lang) extra += line("Tool language", d.lang);
  if (d.score != null && d.overallScore == null) extra += line("Score", d.score);
  if (d.domainScores) extra += line("Domain scores", JSON.stringify(d.domainScores));
  if (d.priorityFindings) extra += line("Priority findings", JSON.stringify(d.priorityFindings));
  if (Array.isArray(d.answers)) extra += line("Answers", JSON.stringify(d.answers));

  return (
    `New lead — ${d.source || d.toolSource || "Website"}\n\n` +
    line("Name", d.name || `${d.firstName || ""} ${d.lastName || ""}`.trim()) +
    line("Company", d.company || d.org) +
    line("Role", d.role || d.jobtitle || d.title) +
    line("Country", d.country) +
    line("Email", d.email) +
    line("Phone", d.phone) +
    line("Service interest", d.service) +
    line("Lead source", d.source) +
    extra +
    line("Message", d.message) +
    line("Consent", d.consent) +
    line("Date submitted", d.submittedAt) +
    line("Page", d.pageUrl)
  );
}

async function sendNotification(d) {
  if (!RESEND_API_KEY || !NOTIFY_TO || !NOTIFY_FROM)
    return { ok: false, skipped: "email env vars not set (RESEND_API_KEY / NOTIFY_EMAIL_TO / NOTIFY_EMAIL_FROM)" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: NOTIFY_TO.split(",").map((x) => x.trim()).filter(Boolean),
      subject: `NEW WEBSITE LEAD | ${d.service || d.toolSource || d.source || "General Enquiry"}`,
      text: emailBody(d),
      reply_to: d.email || undefined,
    }),
  });
  if (!res.ok) return { ok: false, error: `Email ${res.status}: ${await res.text()}` };
  return { ok: true };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });

  let data;
  try { data = JSON.parse(event.body || "{}"); }
  catch { return reply(400, { error: "Invalid JSON" }); }

  if (!data.email && !data.name && !data.company)
    return reply(400, { error: "Empty submission" });

  // Run both; report per-channel outcome. We still return 200 if at least one channel
  // succeeds so the visitor sees success, but the response details aid QA/logging.
  const [hubspot, email] = await Promise.all([
    upsertHubSpotContact(data).catch((e) => ({ ok: false, error: String(e) })),
    sendNotification(data).catch((e) => ({ ok: false, error: String(e) })),
  ]);

  const anyOk = hubspot.ok || email.ok;
  return reply(anyOk ? 200 : 502, { ok: anyOk, hubspot, email });
};
