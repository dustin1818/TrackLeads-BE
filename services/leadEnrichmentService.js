const axios = require("axios");

/**
 * Generate leads from a website URL using an external enrichment API.
 * Abstracts the provider so it can be swapped without touching controllers.
 *
 * @param {string} websiteUrl - The user's website URL
 * @param {object|string[]} excludedLeads - Saved/removed lead exclusion info
 * @returns {Promise<Array>} Array of 20 lead objects
 */
const generateLeadsFromWebsite = async (websiteUrl, excludedLeads = {}) => {
  const domain = new URL(websiteUrl).hostname.replace("www.", "");
  const provider = (
    process.env.LEAD_ENRICHMENT_PROVIDER || "groq"
  ).toLowerCase();

  const excludedEmailSet = new Set();
  const excludedDomainSet = new Set();
  const excludedCompanySet = new Set();

  if (Array.isArray(excludedLeads)) {
    excludedLeads.forEach((email) => {
      if (email) excludedEmailSet.add(String(email).toLowerCase());
    });
  } else {
    (excludedLeads.emails || []).forEach((email) => {
      if (email) excludedEmailSet.add(String(email).toLowerCase());
    });
    (excludedLeads.domains || []).forEach((value) => {
      const normalized = normalizeDomain(value);
      if (normalized) excludedDomainSet.add(normalized);
    });
    (excludedLeads.companyNames || []).forEach((value) => {
      const normalized = normalizeCompanyName(value);
      if (normalized) excludedCompanySet.add(normalized);
    });
  }

  let companies = [];

  try {
    switch (provider) {
      case "groq":
        companies = await fetchFromGroq(domain, excludedEmailSet);
        break;
      case "ai":
      case "openai":
        companies = await fetchFromAIProvider(domain, excludedEmailSet);
        break;
      case "apollo":
        companies = await fetchFromApollo(domain);
        break;
      case "hunter":
        companies = await fetchFromHunter(domain);
        break;
      default:
        companies = generateMockLeads(domain);
    }
  } catch (error) {
    console.error(`Lead enrichment API error (${provider}):`, error.message);
    companies = generateMockLeads(domain);
  }

  const normalized = companies
    .map((c) => {
      const normalizedDomain = normalizeDomain(c.domain || domain);
      const normalizedEmail = (
        c.email || `info@${normalizedDomain}`
      ).toLowerCase();
      const normalizedCompanyName = normalizeCompanyName(c.companyName);

      return {
        companyName: c.companyName,
        domain: normalizedDomain,
        logoUrl: c.logoUrl || `https://logo.clearbit.com/${normalizedDomain}`,
        description: c.description || "",
        email: normalizedEmail,
        isSaved: false,
        normalizedCompanyName,
      };
    })
    .filter(
      (lead) =>
        Boolean(lead.companyName) &&
        Boolean(lead.email) &&
        Boolean(lead.domain) &&
        !excludedEmailSet.has(lead.email) &&
        !excludedDomainSet.has(lead.domain) &&
        !excludedCompanySet.has(lead.normalizedCompanyName),
    );

  const deduped = Array.from(
    new Map(
      normalized.map((lead) => [
        `${lead.email}|${lead.domain}|${lead.normalizedCompanyName}`,
        lead,
      ]),
    ).values(),
  );

  return deduped.slice(0, 20).map(({ normalizedCompanyName, ...lead }) => lead);
};

const fetchFromGroq = async (domain, savedEmailSet = new Set()) => {
  return fetchFromAIProvider(domain, savedEmailSet, {
    apiKey: process.env.GROQ_API_KEY || process.env.AI_API_KEY,
    baseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    model:
      process.env.GROQ_MODEL ||
      process.env.AI_MODEL ||
      "llama-3.3-70b-versatile",
  });
};

const fetchFromAIProvider = async (
  domain,
  excludedEmailSet = new Set(),
  options = {},
) => {
  const apiKey =
    options.apiKey ||
    process.env.AI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.LEAD_ENRICHMENT_API_KEY;
  const baseUrl =
    options.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const model = options.model || process.env.AI_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    throw new Error("Missing AI API key. Set AI_API_KEY or OPENAI_API_KEY.");
  }

  const excludedEmails = Array.from(excludedEmailSet).slice(0, 250).join(", ");

  const systemPrompt =
    "You are a lead research assistant. First infer the website's likely industry, audience, and commercial model from the provided domain. Then return only strict JSON with a top-level array field named leads.";

  const userPrompt = [
    `Analyze the business domain ${domain} and infer the company's likely industry or niche.`,
    `Generate 120 realistic lead companies that complement the business behind ${domain} based on that inferred industry.`,
    "Do not limit results to generic B2B software companies. The leads can be B2B, B2C, ecommerce, agencies, marketplaces, healthcare, education, finance, media, logistics, hospitality, real estate, nonprofits, or other sectors if they fit the inferred industry.",
    "Prefer companies that are natural prospects, channel partners, integration partners, strategic partners, referral partners, suppliers, distributors, or ecosystem fits for the website's industry.",
    "Prioritize industry relevance first, then brand quality, market presence, and realistic fit.",
    "Vary results on each request so the list is not repetitive.",
    "Each lead must include: companyName, domain, description, email.",
    "Descriptions should briefly explain why the company complements the website's business domain or industry.",
    "Use unique company domains and valid business-like emails.",
    "Avoid returning the user's own domain.",
    excludedEmails
      ? `Do not return these excluded emails (saved or removed): ${excludedEmails}`
      : "",
    'Output format example: {"leads":[{"companyName":"...","domain":"...","description":"...","email":"..."}]}',
    "Return JSON only. No markdown.",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await axios.post(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      model,
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    },
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { leads: [] };
  }

  const rawLeads = Array.isArray(parsed?.leads) ? parsed.leads : [];

  return rawLeads
    .map((lead) => {
      const normalizedDomain = String(lead.domain || "")
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]
        .trim();

      const fallbackEmail = normalizedDomain ? `info@${normalizedDomain}` : "";
      const normalizedEmail = String(lead.email || fallbackEmail)
        .toLowerCase()
        .trim();

      return {
        companyName: String(lead.companyName || "").trim(),
        domain: normalizedDomain,
        logoUrl: normalizedDomain
          ? `https://logo.clearbit.com/${normalizedDomain}`
          : undefined,
        description: String(lead.description || "").trim(),
        email: normalizedEmail,
      };
    })
    .filter(
      (lead) =>
        Boolean(lead.companyName) &&
        Boolean(lead.domain) &&
        Boolean(lead.email) &&
        lead.domain !== domain,
    );
};

const fetchFromApollo = async (domain) => {
  const response = await axios.get(
    "https://api.apollo.io/v1/mixed_companies/search",
    {
      params: { q_organization_domains: domain, per_page: 50 },
      headers: { "X-Api-Key": process.env.LEAD_ENRICHMENT_API_KEY },
    },
  );

  return (response.data.organizations || []).map((c) => ({
    companyName: c.name,
    domain: c.primary_domain,
    logoUrl: `https://logo.clearbit.com/${c.primary_domain}`,
    description: c.short_description || "",
    email: c.contact_email || `info@${c.primary_domain}`,
  }));
};

const fetchFromHunter = async (domain) => {
  const response = await axios.get("https://api.hunter.io/v2/domain-search", {
    params: {
      domain,
      api_key: process.env.LEAD_ENRICHMENT_API_KEY,
      limit: 50,
    },
  });

  const data = response.data.data;
  return (data.emails || []).map((entry) => ({
    companyName: data.organization || domain,
    domain: data.domain || domain,
    logoUrl: `https://logo.clearbit.com/${data.domain || domain}`,
    description:
      `${entry.first_name || ""} ${entry.last_name || ""} — ${entry.position || "Contact"} at ${data.organization || domain}`.trim(),
    email: entry.value,
  }));
};

/**
 * Mock data generator for development/demo when no API key is configured
 */
const generateMockLeads = (domain) => {
  const largeCompanies = [
    { companyName: "Webflow", domain: "webflow.com" },
    { companyName: "Envato", domain: "envato.com" },
    { companyName: "Shopify", domain: "shopify.com" },
    { companyName: "HubSpot", domain: "hubspot.com" },
    { companyName: "Atlassian", domain: "atlassian.com" },
    { companyName: "Slack", domain: "slack.com" },
    { companyName: "Notion", domain: "notion.so" },
    { companyName: "Canva", domain: "canva.com" },
    { companyName: "Stripe", domain: "stripe.com" },
    { companyName: "Adobe", domain: "adobe.com" },
    { companyName: "Figma", domain: "figma.com" },
    { companyName: "Twilio", domain: "twilio.com" },
    { companyName: "Asana", domain: "asana.com" },
    { companyName: "Monday.com", domain: "monday.com" },
    { companyName: "Airtable", domain: "airtable.com" },
    { companyName: "Datadog", domain: "datadoghq.com" },
    { companyName: "Cloudflare", domain: "cloudflare.com" },
    { companyName: "Snowflake", domain: "snowflake.com" },
    { companyName: "Salesforce", domain: "salesforce.com" },
    { companyName: "Zoom", domain: "zoom.us" },
    { companyName: "Zendesk", domain: "zendesk.com" },
    { companyName: "Intercom", domain: "intercom.com" },
    { companyName: "Klaviyo", domain: "klaviyo.com" },
    { companyName: "GitLab", domain: "gitlab.com" },
    { companyName: "DocuSign", domain: "docusign.com" },
    { companyName: "Mailchimp", domain: "mailchimp.com" },
    { companyName: "Square", domain: "squareup.com" },
    { companyName: "PayPal", domain: "paypal.com" },
    { companyName: "Miro", domain: "miro.com" },
    { companyName: "Linear", domain: "linear.app" },
  ];

  const shuffled = [...largeCompanies].sort(() => Math.random() - 0.5);

  return shuffled.map((company) => ({
    companyName: company.companyName,
    domain: company.domain,
    logoUrl: `https://logo.clearbit.com/${company.domain}`,
    description: `${company.companyName} is a leading platform that can be a strategic partner or target account for ${domain}.`,
    email: `partnerships@${company.domain}`,
  }));
};

const normalizeDomain = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();

const normalizeCompanyName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

module.exports = { generateLeadsFromWebsite };
