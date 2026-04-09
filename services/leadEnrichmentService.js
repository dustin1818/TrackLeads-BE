const axios = require("axios");
const dns = require("dns").promises;

const MAX_LEADS_TO_RETURN = 20;
const MAX_CANDIDATES_TO_VERIFY = 500;
const LIVE_DOMAIN_CHECK_CONCURRENCY = 6;
const MAX_RELATED_SEED_LEADS = 12;

const REGION_GROUPS = [
  "North America and Central America",
  "South America and the Caribbean",
  "Western Europe and Scandinavia",
  "Eastern Europe and Central Asia",
  "Middle East and North Africa",
  "Sub-Saharan Africa",
  "South Asia and Southeast Asia",
  "East Asia (China, Japan, South Korea, Taiwan)",
  "Australia, New Zealand, and Pacific Islands",
];

const getRandomRegions = (count = 3) => {
  const shuffled = [...REGION_GROUPS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).join(", ");
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const inferredIndustry = inferIndustryFromContext(domain);
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
        companies = await fetchFromGroq(domain, excludedEmailSet, {
          industry: inferredIndustry,
        });
        break;
      case "ai":
      case "openai":
        companies = await fetchFromAIProvider(domain, excludedEmailSet, {
          industry: inferredIndustry,
        });
        break;
      case "apollo":
        companies = await fetchFromApollo(domain);
        break;
      case "hunter":
        companies = await fetchFromHunter(domain);
        break;
      default:
        companies = generatePopularFallbackLeads(domain, [], inferredIndustry);
    }
  } catch (error) {
    console.error(`Lead enrichment API error (${provider}):`, error.message);
    companies = generatePopularFallbackLeads(domain, [], inferredIndustry);
  }

  const deduped = dedupeLeads(
    normalizeLeadResults(companies, domain, {
      excludedEmailSet,
      excludedDomainSet,
      excludedCompanySet,
    }),
  );

  // Verify candidate domains before returning leads so expired or dead sites are filtered out.
  let verifiedLeads = await filterLiveLeads(
    deduped.slice(0, MAX_CANDIDATES_TO_VERIFY),
    MAX_LEADS_TO_RETURN,
  );

  if (verifiedLeads.length < MAX_LEADS_TO_RETURN) {
    await delay(2000); // avoid 429 rate limit
    const supplementalCompanies = await fetchSupplementalCompanies({
      domain,
      industry: inferredIndustry,
      provider,
      verifiedLeads,
      excludedEmailSet,
      excludedDomainSet,
      excludedCompanySet,
    });

    const supplementalLeads = dedupeLeads(
      normalizeLeadResults(supplementalCompanies, domain, {
        excludedEmailSet: new Set([
          ...excludedEmailSet,
          ...deduped.map((lead) => lead.email),
          ...verifiedLeads.map((lead) => lead.email),
        ]),
        excludedDomainSet: new Set([
          ...excludedDomainSet,
          ...deduped.map((lead) => lead.domain),
          ...verifiedLeads.map((lead) => lead.domain),
        ]),
        excludedCompanySet: new Set([
          ...excludedCompanySet,
          ...deduped.map((lead) => lead.normalizedCompanyName),
          ...verifiedLeads.map((lead) => lead.normalizedCompanyName),
        ]),
      }),
    );

    const remainingSlots = MAX_LEADS_TO_RETURN - verifiedLeads.length;
    const verifiedSupplemental = await filterLiveLeads(
      supplementalLeads.slice(0, MAX_CANDIDATES_TO_VERIFY),
      remainingSlots,
    );

    verifiedLeads = dedupeLeads([
      ...verifiedLeads,
      ...verifiedSupplemental,
    ]).slice(0, MAX_LEADS_TO_RETURN);
  }

  if (verifiedLeads.length < MAX_LEADS_TO_RETURN) {
    const industry =
      inferredIndustry || inferIndustryFromContext(domain, verifiedLeads);
    const allExcludedEmails = new Set([
      ...excludedEmailSet,
      ...deduped.map((lead) => lead.email),
      ...verifiedLeads.map((lead) => lead.email),
    ]);
    const allExcludedDomains = new Set([
      ...excludedDomainSet,
      ...deduped.map((lead) => lead.domain),
      ...verifiedLeads.map((lead) => lead.domain),
    ]);
    const allExcludedCompanies = new Set([
      ...excludedCompanySet,
      ...deduped.map((lead) => lead.normalizedCompanyName),
      ...verifiedLeads.map((lead) => lead.normalizedCompanyName),
    ]);

    await delay(2000); // avoid 429 rate limit
    const industryExpansionCompanies = await fetchIndustryExpansionCompanies({
      domain,
      provider,
      industry,
      verifiedLeads,
      excludedEmailSet: allExcludedEmails,
      excludedDomainSet: allExcludedDomains,
      excludedCompanySet: allExcludedCompanies,
    });

    // delay was already applied before the expansion tier block
    await delay(2000); // avoid 429 before potential fallback tier

    const industryExpansionLeads = dedupeLeads(
      normalizeLeadResults(industryExpansionCompanies, domain, {
        excludedEmailSet: allExcludedEmails,
        excludedDomainSet: allExcludedDomains,
        excludedCompanySet: allExcludedCompanies,
      }),
    );

    const remainingAfterExpansion = MAX_LEADS_TO_RETURN - verifiedLeads.length;
    const verifiedIndustryExpansion = await filterLiveLeads(
      industryExpansionLeads.slice(0, MAX_CANDIDATES_TO_VERIFY),
      remainingAfterExpansion,
    );

    verifiedLeads = dedupeLeads([
      ...verifiedLeads,
      ...verifiedIndustryExpansion,
    ]).slice(0, MAX_LEADS_TO_RETURN);
  }

  if (verifiedLeads.length < MAX_LEADS_TO_RETURN) {
    const industry =
      inferredIndustry || inferIndustryFromContext(domain, verifiedLeads);
    const allExcludedEmails = new Set([
      ...excludedEmailSet,
      ...deduped.map((lead) => lead.email),
      ...verifiedLeads.map((lead) => lead.email),
    ]);
    const allExcludedDomains = new Set([
      ...excludedDomainSet,
      ...deduped.map((lead) => lead.domain),
      ...verifiedLeads.map((lead) => lead.domain),
    ]);
    const allExcludedCompanies = new Set([
      ...excludedCompanySet,
      ...deduped.map((lead) => lead.normalizedCompanyName),
      ...verifiedLeads.map((lead) => lead.normalizedCompanyName),
    ]);

    const industryFallbackCompanies = await fetchIndustryFallbackCompanies({
      domain,
      provider,
      industry,
      verifiedLeads,
      excludedEmailSet: allExcludedEmails,
      excludedDomainSet: allExcludedDomains,
      excludedCompanySet: allExcludedCompanies,
    });

    const industryFallbackLeads = dedupeLeads(
      normalizeLeadResults(industryFallbackCompanies, domain, {
        excludedEmailSet: allExcludedEmails,
        excludedDomainSet: allExcludedDomains,
        excludedCompanySet: allExcludedCompanies,
      }),
    );

    const remainingSlots = MAX_LEADS_TO_RETURN - verifiedLeads.length;
    const verifiedIndustryFallback = await filterLiveLeads(
      industryFallbackLeads.slice(0, MAX_CANDIDATES_TO_VERIFY),
      remainingSlots,
    );

    verifiedLeads = dedupeLeads([
      ...verifiedLeads,
      ...verifiedIndustryFallback,
    ]).slice(0, MAX_LEADS_TO_RETURN);
  }

  return verifiedLeads.map(({ normalizedCompanyName, ...lead }) => lead);
};

const fetchFromGroq = async (
  domain,
  savedEmailSet = new Set(),
  options = {},
) => {
  return fetchFromAIProvider(domain, savedEmailSet, {
    ...options,
    apiKey: process.env.GROQ_API_KEY || process.env.AI_API_KEY,
    baseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    model: process.env.GROQ_MODEL || process.env.AI_MODEL || "qwen/qwen3-32b",
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

  // Only send a tiny sample of exclusions in the prompt to avoid bloating it.
  // Full dedup is handled post-generation by normalizeLeadResults filtering.
  const excludedDomainsSample = Array.from(options.excludedDomainSet || [])
    .slice(-15)
    .join(", ");
  const regionFocus = getRandomRegions(3);
  const relatedLeadSummary = (options.relatedLeads || [])
    .slice(0, MAX_RELATED_SEED_LEADS)
    .map((lead) => `${lead.companyName} (${lead.domain})`)
    .join(", ");
  const targetCount = options.targetCount || 120;
  const industryLabel = options.industry
    ? options.industry.replace(/-/g, " ")
    : null;

  const systemPrompt = industryLabel
    ? `You are a lead research assistant. The source company is in the ${industryLabel} industry. Only suggest companies in the same ${industryLabel} industry. Reject generic B2B/SaaS/IT companies unless they specifically serve ${industryLabel}. Return only strict JSON: {"leads":[...]}.`
    : 'You are a lead research assistant. Infer the website\'s industry from the domain. Return only strict JSON: {"leads":[...]}.';

  const userPrompt = [
    // Main instruction — one block depending on mode
    options.longTailIndustrySearch
      ? `Source: ${domain} (${options.industryLabel || industryLabel || "same industry"}). Generate ${targetCount} real same-industry companies. Focus on lesser-known, regional, niche, and emerging companies especially from: ${regionFocus}. Do not repeat famous brands.`
      : options.industryFallback
        ? `Source: ${domain} (${options.industryLabel}). Generate ${targetCount} real companies in the ${options.industryLabel}. Focus especially on companies from: ${regionFocus}. Include any company size — local clinics, regional firms, startups, independents, mid-market, enterprise. They must be real with working websites.`
        : industryLabel
          ? `Source: ${domain} (${industryLabel} industry). Generate ${targetCount} real same-industry companies from around the world, especially from: ${regionFocus}. Stay in the ${industryLabel} industry.`
          : `Analyze ${domain}, infer its industry, then generate ${targetCount} same-industry companies from around the world.`,
    // Seed context
    relatedLeadSummary
      ? `Already confirmed same-industry companies: ${relatedLeadSummary}. Generate different ones.`
      : null,
    // Core rules (compact)
    "Only include companies with real, currently active websites.",
    "Each lead: companyName, domain, description, email. Use info@domain if no specific email.",
    "Vary results — do not repeat the same companies across calls.",
    `Avoid the source domain: ${domain}.`,
    excludedDomainsSample
      ? `Skip these domains (already saved): ${excludedDomainsSample}`
      : null,
    '{"leads":[{"companyName":"...","domain":"...","description":"...","email":"..."}]}',
    "Return JSON only.",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await axios.post(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      model,
      temperature: options.temperature || 0.7,
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
      timeout: 60000,
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

const fetchIndustryExpansionCompanies = async ({
  domain,
  provider,
  industry,
  verifiedLeads,
  excludedEmailSet,
  excludedDomainSet,
  excludedCompanySet,
}) => {
  const industryLabel = industry
    ? `${industry} industry`
    : "the same industry as the source website";

  const expansionOptions = {
    targetCount: 160,
    excludedDomainSet,
    excludedCompanySet,
    longTailIndustrySearch: true,
    industry,
    industryLabel,
    temperature: 0.9,
    relatedLeads: verifiedLeads.slice(0, MAX_RELATED_SEED_LEADS),
  };

  try {
    switch (provider) {
      case "groq":
        return await fetchFromGroq(domain, excludedEmailSet, expansionOptions);
      case "ai":
      case "openai":
        return await fetchFromAIProvider(
          domain,
          excludedEmailSet,
          expansionOptions,
        );
      default:
        return [];
    }
  } catch (error) {
    console.error("Industry expansion generation error:", error.message);
    return [];
  }
};

const fetchIndustryFallbackCompanies = async ({
  domain,
  provider,
  industry,
  verifiedLeads,
  excludedEmailSet,
  excludedDomainSet,
  excludedCompanySet,
}) => {
  const industryLabel = industry
    ? `${industry} industry`
    : "the same industry as the source website";

  const industryOptions = {
    targetCount: 200,
    excludedDomainSet,
    excludedCompanySet,
    industryFallback: true,
    industry,
    industryLabel,
    temperature: 1.0,
    relatedLeads: verifiedLeads.slice(0, MAX_RELATED_SEED_LEADS),
  };

  try {
    switch (provider) {
      case "groq":
        return await fetchFromGroq(domain, excludedEmailSet, industryOptions);
      case "ai":
      case "openai":
        return await fetchFromAIProvider(
          domain,
          excludedEmailSet,
          industryOptions,
        );
      default:
        return generatePopularFallbackLeads(domain, verifiedLeads, industry);
    }
  } catch (error) {
    console.error("Industry fallback generation error:", error.message);
    return generatePopularFallbackLeads(domain, verifiedLeads, industry);
  }
};

const fetchSupplementalCompanies = async ({
  domain,
  industry,
  provider,
  verifiedLeads,
  excludedEmailSet,
  excludedDomainSet,
  excludedCompanySet,
}) => {
  if (!verifiedLeads.length) {
    return [];
  }

  try {
    switch (provider) {
      case "groq":
        return await fetchFromGroq(domain, excludedEmailSet, {
          industry,
          relatedLeads: verifiedLeads,
          targetCount: 120,
          temperature: 0.8,
          excludedDomainSet,
          excludedCompanySet,
        });
      case "ai":
      case "openai":
        return await fetchFromAIProvider(domain, excludedEmailSet, {
          industry,
          relatedLeads: verifiedLeads,
          targetCount: 120,
          temperature: 0.8,
          excludedDomainSet,
          excludedCompanySet,
        });
      default:
        return generatePopularFallbackLeads(domain, verifiedLeads, industry);
    }
  } catch (error) {
    console.error("Supplemental lead generation error:", error.message);
    return generatePopularFallbackLeads(domain, verifiedLeads, industry);
  }
};

const normalizeLeadResults = (
  companies,
  domain,
  { excludedEmailSet, excludedDomainSet, excludedCompanySet },
) => {
  return companies
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
};

const dedupeLeads = (leads) => {
  return Array.from(
    new Map(
      leads.map((lead) => [
        `${lead.email}|${lead.domain}|${lead.normalizedCompanyName}`,
        lead,
      ]),
    ).values(),
  );
};

const filterLiveLeads = async (leads, limit) => {
  const verified = [];
  let currentIndex = 0;

  const worker = async () => {
    while (currentIndex < leads.length && verified.length < limit) {
      const lead = leads[currentIndex++];

      if (await hasLiveWebsite(lead.domain)) {
        verified.push(lead);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(LIVE_DOMAIN_CHECK_CONCURRENCY, leads.length) },
      () => worker(),
    ),
  );

  return verified.slice(0, limit);
};

const hasLiveWebsite = async (domain) => {
  const normalizedDomain = normalizeDomain(domain);

  if (!normalizedDomain) {
    return false;
  }

  const hostsToResolve = Array.from(
    new Set([
      normalizedDomain,
      normalizedDomain.startsWith("www.")
        ? normalizedDomain.slice(4)
        : `www.${normalizedDomain}`,
    ]),
  );

  let hasDnsRecord = false;

  for (const host of hostsToResolve) {
    try {
      await dns.lookup(host);
      hasDnsRecord = true;
      break;
    } catch {}
  }

  if (!hasDnsRecord) {
    return false;
  }

  const urlsToCheck = Array.from(
    new Set(
      [
        `https://${normalizedDomain}`,
        normalizedDomain.startsWith("www.")
          ? ""
          : `https://www.${normalizedDomain}`,
        `http://${normalizedDomain}`,
      ].filter(Boolean),
    ),
  );

  for (const url of urlsToCheck) {
    try {
      const response = await axios.get(url, {
        timeout: 4000,
        maxRedirects: 5,
        maxContentLength: 250000,
        maxBodyLength: 250000,
        validateStatus: (status) => status >= 200 && status < 500,
        headers: {
          "User-Agent": "TrackLeadsBot/1.0",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (isLikelyLiveWebsiteResponse(response)) {
        return true;
      }
    } catch {}
  }

  return false;
};

const isLikelyLiveWebsiteResponse = (response) => {
  const status = Number(response?.status || 0);

  if (!status) {
    return false;
  }

  if ([401, 403, 405].includes(status)) {
    return true;
  }

  if (status < 200 || status >= 400) {
    return false;
  }

  const contentType = String(
    response?.headers?.["content-type"] || "",
  ).toLowerCase();
  const body =
    typeof response?.data === "string" ? response.data.toLowerCase() : "";

  if (contentType && !contentType.includes("text/html")) {
    return false;
  }

  const deadSiteSignals = [
    "domain for sale",
    "buy this domain",
    "this domain is for sale",
    "parked free",
    "sedo domain parking",
    "hugedomains.com",
    "godaddy auctions",
    "website coming soon",
    "coming soon",
    "page not found",
    "404 not found",
    "site not found",
    "website is no longer available",
    "domain is available",
    "this site can't be reached",
  ];

  return !deadSiteSignals.some((signal) => body.includes(signal));
};

const INDUSTRY_POOLS = {
  healthcare: [
    { companyName: "Johnson & Johnson", domain: "jnj.com" },
    { companyName: "Pfizer", domain: "pfizer.com" },
    { companyName: "Novartis", domain: "novartis.com" },
    { companyName: "AstraZeneca", domain: "astrazeneca.com" },
    { companyName: "Roche", domain: "roche.com" },
    { companyName: "Merck", domain: "merck.com" },
    { companyName: "AbbVie", domain: "abbvie.com" },
    { companyName: "Bristol-Myers Squibb", domain: "bms.com" },
    { companyName: "Eli Lilly", domain: "lilly.com" },
    { companyName: "Sanofi", domain: "sanofi.com" },
    { companyName: "Medtronic", domain: "medtronic.com" },
    { companyName: "Abbott Laboratories", domain: "abbott.com" },
    { companyName: "Stryker", domain: "stryker.com" },
    { companyName: "Becton Dickinson", domain: "bd.com" },
    { companyName: "Zimmer Biomet", domain: "zimmerbiomet.com" },
    { companyName: "Baxter International", domain: "baxter.com" },
    { companyName: "GE HealthCare", domain: "gehealthcare.com" },
    { companyName: "Siemens Healthineers", domain: "siemens-healthineers.com" },
    { companyName: "Philips Healthcare", domain: "philips.com" },
    { companyName: "Epic Systems", domain: "epic.com" },
    { companyName: "Cerner", domain: "cerner.com" },
    { companyName: "McKesson", domain: "mckesson.com" },
    { companyName: "Cardinal Health", domain: "cardinalhealth.com" },
    { companyName: "UnitedHealth Group", domain: "unitedhealthgroup.com" },
    { companyName: "CVS Health", domain: "cvshealth.com" },
    { companyName: "Cigna", domain: "cigna.com" },
    { companyName: "Aetna", domain: "aetna.com" },
    { companyName: "Anthem", domain: "anthem.com" },
    { companyName: "Humana", domain: "humana.com" },
    { companyName: "Fresenius", domain: "fresenius.com" },
    { companyName: "Hologic", domain: "hologic.com" },
    { companyName: "Danaher", domain: "danaher.com" },
    { companyName: "Thermo Fisher Scientific", domain: "thermofisher.com" },
    { companyName: "Quest Diagnostics", domain: "questdiagnostics.com" },
    { companyName: "LabCorp", domain: "labcorp.com" },
    { companyName: "DaVita", domain: "davita.com" },
    { companyName: "HCA Healthcare", domain: "hcahealthcare.com" },
    { companyName: "Tenet Healthcare", domain: "tenethealth.com" },
    { companyName: "Kindred Healthcare", domain: "kindredhealthcare.com" },
    { companyName: "Teladoc Health", domain: "teladochealth.com" },
  ],
  finance: [
    { companyName: "JPMorgan Chase", domain: "jpmorgan.com" },
    { companyName: "Bank of America", domain: "bankofamerica.com" },
    { companyName: "Wells Fargo", domain: "wellsfargo.com" },
    { companyName: "Citigroup", domain: "citigroup.com" },
    { companyName: "Goldman Sachs", domain: "goldmansachs.com" },
    { companyName: "Morgan Stanley", domain: "morganstanley.com" },
    { companyName: "BlackRock", domain: "blackrock.com" },
    { companyName: "Fidelity Investments", domain: "fidelity.com" },
    { companyName: "Vanguard", domain: "vanguard.com" },
    { companyName: "Charles Schwab", domain: "schwab.com" },
    { companyName: "Visa", domain: "visa.com" },
    { companyName: "Mastercard", domain: "mastercard.com" },
    { companyName: "American Express", domain: "americanexpress.com" },
    { companyName: "Stripe", domain: "stripe.com" },
    { companyName: "PayPal", domain: "paypal.com" },
    { companyName: "Intuit", domain: "intuit.com" },
    { companyName: "Bloomberg", domain: "bloomberg.com" },
    { companyName: "Moody's", domain: "moodys.com" },
    { companyName: "S&P Global", domain: "spglobal.com" },
    { companyName: "Deloitte", domain: "deloitte.com" },
    { companyName: "PwC", domain: "pwc.com" },
    { companyName: "KPMG", domain: "kpmg.com" },
    { companyName: "EY", domain: "ey.com" },
    { companyName: "Xero", domain: "xero.com" },
    { companyName: "Plaid", domain: "plaid.com" },
    { companyName: "Brex", domain: "brex.com" },
    { companyName: "Affirm", domain: "affirm.com" },
    { companyName: "Robinhood", domain: "robinhood.com" },
    { companyName: "Coinbase", domain: "coinbase.com" },
    { companyName: "Square", domain: "squareup.com" },
  ],
  education: [
    { companyName: "Coursera", domain: "coursera.org" },
    { companyName: "edX", domain: "edx.org" },
    { companyName: "Khan Academy", domain: "khanacademy.org" },
    { companyName: "Udemy", domain: "udemy.com" },
    { companyName: "Skillshare", domain: "skillshare.com" },
    { companyName: "Duolingo", domain: "duolingo.com" },
    { companyName: "Pearson", domain: "pearson.com" },
    { companyName: "McGraw-Hill Education", domain: "mheducation.com" },
    { companyName: "Chegg", domain: "chegg.com" },
    { companyName: "Instructure (Canvas)", domain: "instructure.com" },
    { companyName: "Blackboard", domain: "blackboard.com" },
    { companyName: "Turnitin", domain: "turnitin.com" },
    { companyName: "Quizlet", domain: "quizlet.com" },
    { companyName: "Rosetta Stone", domain: "rosettastone.com" },
    { companyName: "Scholastic", domain: "scholastic.com" },
    { companyName: "Renaissance Learning", domain: "renaissance.com" },
    { companyName: "PowerSchool", domain: "powerschool.com" },
    { companyName: "Follett", domain: "follett.com" },
    { companyName: "Cengage", domain: "cengage.com" },
    { companyName: "Houghton Mifflin Harcourt", domain: "hmhco.com" },
  ],
  retail: [
    { companyName: "Shopify", domain: "shopify.com" },
    { companyName: "BigCommerce", domain: "bigcommerce.com" },
    { companyName: "WooCommerce", domain: "woocommerce.com" },
    { companyName: "Magento (Adobe Commerce)", domain: "magento.com" },
    { companyName: "Wix eCommerce", domain: "wix.com" },
    { companyName: "Square", domain: "squareup.com" },
    { companyName: "Lightspeed", domain: "lightspeedcommerce.com" },
    { companyName: "Stripe", domain: "stripe.com" },
    { companyName: "PayPal", domain: "paypal.com" },
    { companyName: "FedEx", domain: "fedex.com" },
    { companyName: "UPS", domain: "ups.com" },
    { companyName: "ShipBob", domain: "shipbob.com" },
    { companyName: "Returnly", domain: "returnly.com" },
    { companyName: "Klaviyo", domain: "klaviyo.com" },
    { companyName: "Yotpo", domain: "yotpo.com" },
    { companyName: "Bazaarvoice", domain: "bazaarvoice.com" },
    { companyName: "ChannelAdvisor", domain: "channeladvisor.com" },
    { companyName: "Netsuite", domain: "netsuite.com" },
    { companyName: "Cin7", domain: "cin7.com" },
    { companyName: "Linnworks", domain: "linnworks.com" },
  ],
  hospitality: [
    { companyName: "Marriott International", domain: "marriott.com" },
    { companyName: "Hilton", domain: "hilton.com" },
    { companyName: "Hyatt", domain: "hyatt.com" },
    { companyName: "IHG Hotels & Resorts", domain: "ihg.com" },
    { companyName: "Wyndham Hotels", domain: "wyndhamhotels.com" },
    { companyName: "Booking.com", domain: "booking.com" },
    { companyName: "Expedia Group", domain: "expediagroup.com" },
    { companyName: "TripAdvisor", domain: "tripadvisor.com" },
    { companyName: "Trivago", domain: "trivago.com" },
    { companyName: "Oracle Hospitality", domain: "oracle.com" },
    { companyName: "Amadeus", domain: "amadeus.com" },
    { companyName: "Sabre", domain: "sabre.com" },
    { companyName: "Cloudbeds", domain: "cloudbeds.com" },
    { companyName: "Mews", domain: "mews.com" },
    { companyName: "Agilysys", domain: "agilysys.com" },
    { companyName: "Cvent", domain: "cvent.com" },
    { companyName: "SevenRooms", domain: "sevenrooms.com" },
    { companyName: "Toast", domain: "toasttab.com" },
    { companyName: "Lightspeed Restaurant", domain: "lightspeedcommerce.com" },
    { companyName: "Ecolab", domain: "ecolab.com" },
  ],
  manufacturing: [
    { companyName: "Siemens", domain: "siemens.com" },
    { companyName: "GE", domain: "ge.com" },
    { companyName: "Honeywell", domain: "honeywell.com" },
    { companyName: "3M", domain: "3m.com" },
    { companyName: "Caterpillar", domain: "caterpillar.com" },
    { companyName: "Emerson Electric", domain: "emerson.com" },
    { companyName: "Rockwell Automation", domain: "rockwellautomation.com" },
    { companyName: "Parker Hannifin", domain: "parker.com" },
    { companyName: "Bosch", domain: "bosch.com" },
    { companyName: "ABB", domain: "abb.com" },
    { companyName: "Schneider Electric", domain: "se.com" },
    { companyName: "Eaton", domain: "eaton.com" },
    { companyName: "Autodesk", domain: "autodesk.com" },
    { companyName: "PTC", domain: "ptc.com" },
    { companyName: "Dassault Systèmes", domain: "3ds.com" },
    { companyName: "SAP", domain: "sap.com" },
    { companyName: "Oracle Manufacturing", domain: "oracle.com" },
    { companyName: "Infor", domain: "infor.com" },
    { companyName: "AVEVA", domain: "aveva.com" },
    { companyName: "Hexagon", domain: "hexagon.com" },
  ],
  legal: [
    { companyName: "LexisNexis", domain: "lexisnexis.com" },
    { companyName: "Thomson Reuters", domain: "thomsonreuters.com" },
    { companyName: "Westlaw", domain: "westlaw.com" },
    { companyName: "Clio", domain: "clio.com" },
    { companyName: "MyCase", domain: "mycase.com" },
    { companyName: "PracticePanther", domain: "practicepanther.com" },
    { companyName: "DocuSign", domain: "docusign.com" },
    { companyName: "LegalZoom", domain: "legalzoom.com" },
    { companyName: "Rocket Lawyer", domain: "rocketlawyer.com" },
    { companyName: "Relativity", domain: "relativity.com" },
    { companyName: "Disco", domain: "csdisco.com" },
    { companyName: "Everlaw", domain: "everlaw.com" },
    { companyName: "ContractPodAi", domain: "contractpodai.com" },
    { companyName: "Ironclad", domain: "ironcladapp.com" },
    { companyName: "Litera", domain: "litera.com" },
    { companyName: "NetDocuments", domain: "netdocuments.com" },
    { companyName: "iManage", domain: "imanage.com" },
    { companyName: "Filevine", domain: "filevine.com" },
    { companyName: "Aderant", domain: "aderant.com" },
    { companyName: "Wolters Kluwer", domain: "wolterskluwer.com" },
  ],
  default: [
    { companyName: "Google Cloud", domain: "cloud.google.com" },
    { companyName: "Microsoft", domain: "microsoft.com" },
    { companyName: "Amazon Web Services", domain: "aws.amazon.com" },
    { companyName: "NVIDIA", domain: "nvidia.com" },
    { companyName: "Intel", domain: "intel.com" },
    { companyName: "Dell", domain: "dell.com" },
    { companyName: "Cisco", domain: "cisco.com" },
    { companyName: "IBM", domain: "ibm.com" },
    { companyName: "Oracle", domain: "oracle.com" },
    { companyName: "SAP", domain: "sap.com" },
    { companyName: "Workday", domain: "workday.com" },
    { companyName: "Adobe", domain: "adobe.com" },
    { companyName: "Salesforce", domain: "salesforce.com" },
    { companyName: "Shopify", domain: "shopify.com" },
    { companyName: "HubSpot", domain: "hubspot.com" },
    { companyName: "Stripe", domain: "stripe.com" },
    { companyName: "Atlassian", domain: "atlassian.com" },
    { companyName: "Slack", domain: "slack.com" },
    { companyName: "Zoom", domain: "zoom.us" },
    { companyName: "Figma", domain: "figma.com" },
    { companyName: "Snowflake", domain: "snowflake.com" },
    { companyName: "Cloudflare", domain: "cloudflare.com" },
    { companyName: "Datadog", domain: "datadoghq.com" },
    { companyName: "Twilio", domain: "twilio.com" },
    { companyName: "DocuSign", domain: "docusign.com" },
    { companyName: "PayPal", domain: "paypal.com" },
    { companyName: "Intuit", domain: "intuit.com" },
    { companyName: "ServiceNow", domain: "servicenow.com" },
    { companyName: "Okta", domain: "okta.com" },
    { companyName: "MongoDB", domain: "mongodb.com" },
    { companyName: "ZoomInfo", domain: "zoominfo.com" },
    { companyName: "Gartner", domain: "gartner.com" },
    { companyName: "McKinsey & Company", domain: "mckinsey.com" },
    { companyName: "Accenture", domain: "accenture.com" },
    { companyName: "Deloitte", domain: "deloitte.com" },
    { companyName: "PwC", domain: "pwc.com" },
    { companyName: "CrowdStrike", domain: "crowdstrike.com" },
    { companyName: "Palo Alto Networks", domain: "paloaltonetworks.com" },
    { companyName: "Fortinet", domain: "fortinet.com" },
    { companyName: "Zscaler", domain: "zscaler.com" },
    { companyName: "Marketo", domain: "marketo.com" },
    { companyName: "Klaviyo", domain: "klaviyo.com" },
    { companyName: "Intercom", domain: "intercom.com" },
    { companyName: "Zendesk", domain: "zendesk.com" },
    { companyName: "Freshworks", domain: "freshworks.com" },
    { companyName: "Gong", domain: "gong.io" },
    { companyName: "Pipedrive", domain: "pipedrive.com" },
    { companyName: "Asana", domain: "asana.com" },
    { companyName: "Monday.com", domain: "monday.com" },
    { companyName: "Zapier", domain: "zapier.com" },
    { companyName: "Visa", domain: "visa.com" },
    { companyName: "Mastercard", domain: "mastercard.com" },
  ],
};

const generatePopularFallbackLeads = (
  domain,
  existingLeads = [],
  industry = null,
) => {
  const pool =
    industry && INDUSTRY_POOLS[industry]
      ? INDUSTRY_POOLS[industry]
      : INDUSTRY_POOLS.default;

  const existingSummary = existingLeads
    .slice(0, 5)
    .map((lead) => lead.companyName)
    .join(", ");

  const industryLabel = industry || "B2B";

  return pool.map((company) => ({
    companyName: company.companyName,
    domain: company.domain,
    logoUrl: `https://logo.clearbit.com/${company.domain}`,
    description: existingSummary
      ? `${company.companyName} is a well-known ${industryLabel} company added as a fallback after prioritizing same-industry leads such as ${existingSummary}.`
      : `${company.companyName} is a well-known ${industryLabel} company added as a fallback when same-industry results are limited for ${domain}.`,
    email: `partnerships@${company.domain}`,
  }));
};

const inferIndustryFromContext = (domain, verifiedLeads = []) => {
  const domainStr = domain.toLowerCase();
  const leadDescriptions = verifiedLeads
    .slice(0, 8)
    .map((l) => (l.description || "").toLowerCase())
    .join(" ");
  const context = `${domainStr} ${leadDescriptions}`;

  const industryPatterns = [
    {
      key: "healthcare",
      keywords: [
        "medical",
        "health",
        "hospital",
        "clinic",
        "pharma",
        "dental",
        "doctor",
        "patient",
        "care",
        "wellness",
        "nursing",
        "surgery",
        "therapy",
        "biotech",
        "lab",
        "diagnostic",
        "radiology",
        "ortho",
        "cardio",
        "oncology",
        "pediatric",
        "med",
        "rx",
        "drug",
        "vaccine",
        "ehr",
        "emr",
        "telemedicine",
        "telehealth",
      ],
    },
    {
      key: "finance",
      keywords: [
        "bank",
        "finance",
        "fintech",
        "invest",
        "insurance",
        "mortgage",
        "loan",
        "credit",
        "accounting",
        "tax",
        "wealth",
        "trading",
        "capital",
        "asset",
        "fund",
        "equity",
        "securities",
        "brokerage",
        "payment",
        "payroll",
        "ledger",
        "crypto",
        "blockchain",
      ],
    },
    {
      key: "education",
      keywords: [
        "school",
        "university",
        "college",
        "edu",
        "learn",
        "education",
        "training",
        "course",
        "academic",
        "tutoring",
        "elearning",
        "curriculum",
        "student",
        "teacher",
        "classroom",
        "campus",
      ],
    },
    {
      key: "retail",
      keywords: [
        "shop",
        "store",
        "retail",
        "ecommerce",
        "commerce",
        "marketplace",
        "cart",
        "merchandise",
        "goods",
        "brand",
        "apparel",
        "fashion",
        "grocery",
        "supermarket",
        "outlet",
        "boutique",
      ],
    },
    {
      key: "hospitality",
      keywords: [
        "hotel",
        "resort",
        "travel",
        "tourism",
        "hospitality",
        "airline",
        "booking",
        "vacation",
        "restaurant",
        "food",
        "dining",
        "chef",
        "catering",
        "lodging",
        "inn",
        "motel",
        "cruise",
        "spa",
      ],
    },
    {
      key: "manufacturing",
      keywords: [
        "manufactur",
        "factory",
        "industrial",
        "engineering",
        "construction",
        "logistics",
        "supply chain",
        "warehouse",
        "production",
        "assembly",
        "machining",
        "fabrication",
        "automotive",
        "aerospace",
        "chemical",
      ],
    },
    {
      key: "legal",
      keywords: [
        "law",
        "legal",
        "attorney",
        "counsel",
        "firm",
        "justice",
        "litigation",
        "paralegal",
        "barrister",
        "solicitor",
        "notary",
        "compliance",
        "regulatory",
        "contract",
      ],
    },
  ];

  for (const pattern of industryPatterns) {
    if (pattern.keywords.some((kw) => context.includes(kw))) {
      return pattern.key;
    }
  }

  return null;
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
