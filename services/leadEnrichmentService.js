const axios = require("axios");
const dns = require("dns").promises;


const CONFIG = {
  maxLeadsToReturn: 20,
  maxCandidatesToVerify: 500,
  domainCheckConcurrency: 6,
  maxRelatedSeedLeads: 12,
  rateLimitDelay: 2000,
  apiTimeout: 60000,
  domainCheckTimeout: 4000,
  priorityRegion: "Philippines",
};


const WORLD_REGIONS = [
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

const GENERATION_TIERS = [
  { name: "supplemental", targetCount: 120, temperature: 0.8 },
  { name: "expansion", targetCount: 160, temperature: 0.9, longTail: true },
  {
    name: "fallback",
    targetCount: 200,
    temperature: 1.0,
    industryFallback: true,
  },
];


const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const getRandomRegions = (count = 3) => {
  const shuffled = [...WORLD_REGIONS].sort(() => Math.random() - 0.5);
  return [CONFIG.priorityRegion, ...shuffled.slice(0, count - 1)].join(", ");
};


const buildExclusionSets = (excludedLeads) => {
  const emails = new Set();
  const domains = new Set();
  const companies = new Set();

  if (Array.isArray(excludedLeads)) {
    excludedLeads.forEach((e) => e && emails.add(String(e).toLowerCase()));
  } else {
    (excludedLeads.emails || []).forEach(
      (e) => e && emails.add(String(e).toLowerCase()),
    );
    (excludedLeads.domains || []).forEach((v) => {
      const d = normalizeDomain(v);
      if (d) domains.add(d);
    });
    (excludedLeads.companyNames || []).forEach((v) => {
      const c = normalizeCompanyName(v);
      if (c) companies.add(c);
    });
  }

  return { emails, domains, companies };
};

const expandExclusions = (base, ...leadArrays) => {
  const all = leadArrays.flat();
  return {
    emails: new Set([...base.emails, ...all.map((l) => l.email)]),
    domains: new Set([...base.domains, ...all.map((l) => l.domain)]),
    companies: new Set([
      ...base.companies,
      ...all.map((l) => l.normalizedCompanyName),
    ]),
  };
};

const generateLeadsFromWebsite = async (websiteUrl, excludedLeads = {}) => {
  const domain = new URL(websiteUrl).hostname.replace("www.", "");
  const provider = (
    process.env.LEAD_ENRICHMENT_PROVIDER || "groq"
  ).toLowerCase();
  const inferredIndustry = inferIndustryFromContext(domain);
  const exclusions = buildExclusionSets(excludedLeads);

  const rawCompanies = await fetchInitialCompanies(
    domain,
    provider,
    inferredIndustry,
    exclusions,
  );

  const initialLeads = dedupeLeads(
    normalizeLeadResults(rawCompanies, domain, exclusions),
  );

  let verified = await filterLiveLeads(
    initialLeads.slice(0, CONFIG.maxCandidatesToVerify),
    CONFIG.maxLeadsToReturn,
  );

  for (const tier of GENERATION_TIERS) {
    if (verified.length >= CONFIG.maxLeadsToReturn) break;

    const industry =
      inferredIndustry || inferIndustryFromContext(domain, verified);
    const grown = expandExclusions(exclusions, initialLeads, verified);

    await delay(CONFIG.rateLimitDelay);

    const tierCompanies = await fetchTierCompanies({
      tier,
      domain,
      provider,
      industry,
      verified,
      exclusions: grown,
    });

    if (tier.name === "expansion") {
      await delay(CONFIG.rateLimitDelay); 
    }

    const tierLeads = dedupeLeads(
      normalizeLeadResults(tierCompanies, domain, grown),
    );
    const remaining = CONFIG.maxLeadsToReturn - verified.length;
    const verifiedTier = await filterLiveLeads(
      tierLeads.slice(0, CONFIG.maxCandidatesToVerify),
      remaining,
    );

    verified = dedupeLeads([...verified, ...verifiedTier]).slice(
      0,
      CONFIG.maxLeadsToReturn,
    );
  }

  return verified.map(({ normalizedCompanyName, ...lead }) => lead);
};


const fetchInitialCompanies = async (
  domain,
  provider,
  industry,
  exclusions,
) => {
  try {
    switch (provider) {
      case "groq":
        return await fetchFromGroq(domain, exclusions.emails, { industry });
      case "ai":
      case "openai":
        return await fetchFromAIProvider(domain, exclusions.emails, {
          industry,
        });
      case "apollo":
        return await fetchFromApollo(domain);
      case "hunter":
        return await fetchFromHunter(domain);
      default:
        return generateFallbackLeads(domain, [], industry);
    }
  } catch (error) {
    console.error(`Initial fetch error (${provider}):`, error.message);
    return generateFallbackLeads(domain, [], industry);
  }
};

const fetchTierCompanies = async ({
  tier,
  domain,
  provider,
  industry,
  verified,
  exclusions,
}) => {
  const industryLabel = industry
    ? `${industry} industry`
    : "the same industry as the source website";

  const options = {
    industry,
    industryLabel,
    targetCount: tier.targetCount,
    temperature: tier.temperature,
    excludedDomainSet: exclusions.domains,
    excludedCompanySet: exclusions.companies,
    relatedLeads: verified.slice(0, CONFIG.maxRelatedSeedLeads),
    longTailIndustrySearch: tier.longTail || false,
    industryFallback: tier.industryFallback || false,
  };

  try {
    switch (provider) {
      case "groq":
        return await fetchFromGroq(domain, exclusions.emails, options);
      case "ai":
      case "openai":
        return await fetchFromAIProvider(domain, exclusions.emails, options);
      default:
        return tier.industryFallback
          ? generateFallbackLeads(domain, verified, industry)
          : [];
    }
  } catch (error) {
    console.error(`Tier "${tier.name}" error:`, error.message);
    return tier.industryFallback
      ? generateFallbackLeads(domain, verified, industry)
      : [];
  }
};


const fetchFromGroq = async (
  domain,
  excludedEmails = new Set(),
  options = {},
) => {
  return fetchFromAIProvider(domain, excludedEmails, {
    ...options,
    apiKey: process.env.GROQ_API_KEY || process.env.AI_API_KEY,
    baseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    model: process.env.GROQ_MODEL || process.env.AI_MODEL || "qwen/qwen3-32b",
  });
};

const fetchFromAIProvider = async (
  domain,
  excludedEmails = new Set(),
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

  if (!apiKey)
    throw new Error("Missing AI API key. Set AI_API_KEY or OPENAI_API_KEY.");

  const { systemPrompt, userPrompt } = buildPrompts(domain, options);

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
      timeout: CONFIG.apiTimeout,
    },
  );

  return parseAIResponse(response, domain);
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
    params: { domain, api_key: process.env.LEAD_ENRICHMENT_API_KEY, limit: 50 },
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


const buildPrompts = (domain, options) => {
  const targetCount = options.targetCount || 120;
  const industryLabel = options.industry
    ? options.industry.replace(/-/g, " ")
    : null;
  const regionFocus = getRandomRegions(3);

  const excludedSample = Array.from(options.excludedDomainSet || [])
    .slice(-15)
    .join(", ");

  const relatedSummary = (options.relatedLeads || [])
    .slice(0, CONFIG.maxRelatedSeedLeads)
    .map((l) => `${l.companyName} (${l.domain})`)
    .join(", ");

  const systemPrompt = industryLabel
    ? `You are a lead research assistant. The source company is in the ${industryLabel} industry. Only suggest companies in the same ${industryLabel} industry. Reject generic B2B/SaaS/IT companies unless they specifically serve ${industryLabel}. Return only strict JSON: {"leads":[...]}.`
    : 'You are a lead research assistant. Infer the website\'s industry from the domain. Return only strict JSON: {"leads":[...]}.';

  const mainInstruction = buildMainInstruction(domain, {
    ...options,
    industryLabel,
    regionFocus,
    targetCount,
  });

  const userPrompt = [
    mainInstruction,
    relatedSummary
      ? `Already confirmed same-industry companies: ${relatedSummary}. Generate different ones.`
      : null,
    "Only include companies with real, currently active websites.",
    "Each lead: companyName, domain, description, email. Use info@domain if no specific email.",
    "Vary results — do not repeat the same companies across calls.",
    `Avoid the source domain: ${domain}.`,
    excludedSample
      ? `Skip these domains (already saved): ${excludedSample}`
      : null,
    '{"leads":[{"companyName":"...","domain":"...","description":"...","email":"..."}]}',
    "Return JSON only.",
  ]
    .filter(Boolean)
    .join("\n");

  return { systemPrompt, userPrompt };
};

const buildMainInstruction = (domain, opts) => {
  const { industryLabel, regionFocus, targetCount } = opts;
  const ph = `Prioritize companies based in the ${CONFIG.priorityRegion} first`;

  if (opts.longTailIndustrySearch) {
    return `Source: ${domain} (${opts.industryLabel || industryLabel || "same industry"}). Generate ${targetCount} real same-industry companies. ${ph}, then include lesser-known, regional, niche, and emerging companies from: ${regionFocus}. Do not repeat famous brands.`;
  }
  if (opts.industryFallback) {
    return `Source: ${domain} (${opts.industryLabel}). Generate ${targetCount} real companies in the ${opts.industryLabel}. ${ph}, then include companies from: ${regionFocus}. Include any company size — local clinics, regional firms, startups, independents, mid-market, enterprise. They must be real with working websites.`;
  }
  if (industryLabel) {
    return `Source: ${domain} (${industryLabel} industry). Generate ${targetCount} real same-industry companies. ${ph}, then include companies from around the world, especially from: ${regionFocus}. Stay in the ${industryLabel} industry.`;
  }
  return `Analyze ${domain}, infer its industry, then generate ${targetCount} same-industry companies. ${ph}, then include companies from around the world.`;
};


const parseAIResponse = (response, sourceDomain) => {
  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) return [];

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { leads: [] };
  }

  return (Array.isArray(parsed?.leads) ? parsed.leads : [])
    .map((lead) => {
      const domain = normalizeDomain(lead.domain || "");
      const email = String(lead.email || (domain ? `info@${domain}` : ""))
        .toLowerCase()
        .trim();

      return {
        companyName: String(lead.companyName || "").trim(),
        domain,
        logoUrl: domain ? `https://logo.clearbit.com/${domain}` : undefined,
        description: String(lead.description || "").trim(),
        email,
      };
    })
    .filter(
      (l) => l.companyName && l.domain && l.email && l.domain !== sourceDomain,
    );
};


const normalizeLeadResults = (companies, domain, exclusions) => {
  // Support both {emails,domains,companies} and legacy key names
  const emailSet = exclusions.emails || exclusions.excludedEmailSet;
  const domainSet = exclusions.domains || exclusions.excludedDomainSet;
  const companySet = exclusions.companies || exclusions.excludedCompanySet;

  return companies
    .map((c) => {
      const d = normalizeDomain(c.domain || domain);
      const email = (c.email || `info@${d}`).toLowerCase();
      const companyKey = normalizeCompanyName(c.companyName);

      return {
        companyName: c.companyName,
        domain: d,
        logoUrl: c.logoUrl || `https://logo.clearbit.com/${d}`,
        description: c.description || "",
        email,
        isSaved: false,
        normalizedCompanyName: companyKey,
      };
    })
    .filter(
      (l) =>
        l.companyName &&
        l.email &&
        l.domain &&
        !emailSet.has(l.email) &&
        !domainSet.has(l.domain) &&
        !companySet.has(l.normalizedCompanyName),
    );
};

const dedupeLeads = (leads) =>
  Array.from(
    new Map(
      leads.map((l) => [
        `${l.email}|${l.domain}|${l.normalizedCompanyName}`,
        l,
      ]),
    ).values(),
  );


const filterLiveLeads = async (leads, limit) => {
  const verified = [];
  let idx = 0;

  const worker = async () => {
    while (idx < leads.length && verified.length < limit) {
      const lead = leads[idx++];
      if (await hasLiveWebsite(lead.domain)) verified.push(lead);
    }
  };

  const poolSize = Math.min(CONFIG.domainCheckConcurrency, leads.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return verified.slice(0, limit);
};

const hasLiveWebsite = async (rawDomain) => {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return false;

  const variants = [
    domain,
    domain.startsWith("www.") ? domain.slice(4) : `www.${domain}`,
  ];
  const uniqueHosts = [...new Set(variants)];

  let dnsOk = false;
  for (const host of uniqueHosts) {
    try {
      await dns.lookup(host);
      dnsOk = true;
      break;
    } catch {}
  }
  if (!dnsOk) return false;

  const urls = [
    `https://${domain}`,
    domain.startsWith("www.") ? null : `https://www.${domain}`,
    `http://${domain}`,
  ].filter(Boolean);

  for (const url of [...new Set(urls)]) {
    try {
      const res = await axios.get(url, {
        timeout: CONFIG.domainCheckTimeout,
        maxRedirects: 5,
        maxContentLength: 250_000,
        maxBodyLength: 250_000,
        validateStatus: (s) => s >= 200 && s < 500,
        headers: {
          "User-Agent": "TrackLeadsBot/1.0",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (isLiveResponse(res)) return true;
    } catch {}
  }

  return false;
};

const DEAD_SITE_SIGNALS = [
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

const isLiveResponse = (response) => {
  const status = Number(response?.status || 0);
  if (!status) return false;
  if ([401, 403, 405].includes(status)) return true;
  if (status < 200 || status >= 400) return false;

  const contentType = String(
    response?.headers?.["content-type"] || "",
  ).toLowerCase();
  if (contentType && !contentType.includes("text/html")) return false;

  const body =
    typeof response?.data === "string" ? response.data.toLowerCase() : "";
  return !DEAD_SITE_SIGNALS.some((signal) => body.includes(signal));
};


const INDUSTRY_KEYWORDS = {
  healthcare: [
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
  finance: [
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
  education: [
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
  retail: [
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
  hospitality: [
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
  manufacturing: [
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
  legal: [
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
};

const inferIndustryFromContext = (domain, verifiedLeads = []) => {
  const descriptions = verifiedLeads
    .slice(0, 8)
    .map((l) => (l.description || "").toLowerCase())
    .join(" ");
  const context = `${domain.toLowerCase()} ${descriptions}`;

  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    if (keywords.some((kw) => context.includes(kw))) return industry;
  }
  return null;
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

const generateFallbackLeads = (domain, existingLeads = [], industry = null) => {
  const pool = (industry && INDUSTRY_POOLS[industry]) || INDUSTRY_POOLS.default;
  const label = industry || "B2B";
  const existing = existingLeads
    .slice(0, 5)
    .map((l) => l.companyName)
    .join(", ");

  return pool.map((c) => ({
    companyName: c.companyName,
    domain: c.domain,
    logoUrl: `https://logo.clearbit.com/${c.domain}`,
    description: existing
      ? `${c.companyName} is a well-known ${label} company added as a fallback after prioritizing same-industry leads such as ${existing}.`
      : `${c.companyName} is a well-known ${label} company added as a fallback when same-industry results are limited for ${domain}.`,
    email: `partnerships@${c.domain}`,
  }));
};


module.exports = { generateLeadsFromWebsite };
