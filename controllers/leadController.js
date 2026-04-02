const { body, validationResult } = require("express-validator");
const Lead = require("../models/Lead");
const RemovedLead = require("../models/RemovedLead");
const {
  generateLeadsFromWebsite,
} = require("../services/leadEnrichmentService");

const generateValidation = [
  body("websiteUrl").isURL().withMessage("Please provide a valid URL"),
];

const saveValidation = [
  body("companyName").trim().notEmpty().withMessage("Company name is required"),
  body("email").isEmail().withMessage("Valid email is required"),
];

const removeValidation = [
  body("companyName").trim().notEmpty().withMessage("Company name is required"),
  body("email").isEmail().withMessage("Valid email is required"),
];

const generateLeads = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    const { websiteUrl } = req.body;

    const savedLeads = await Lead.find({ user: req.user._id }).select(
      "email domain companyName",
    );
    const removedLeads = await RemovedLead.find({ user: req.user._id }).select(
      "email domain companyName",
    );

    const excludedEmails = new Set();
    const excludedDomains = new Set();
    const excludedCompanyNames = new Set();

    [...savedLeads, ...removedLeads].forEach((lead) => {
      if (lead.email) excludedEmails.add(lead.email.toLowerCase());
      if (lead.domain) excludedDomains.add(String(lead.domain).toLowerCase());
      if (lead.companyName) excludedCompanyNames.add(lead.companyName);
    });

    const leads = await generateLeadsFromWebsite(websiteUrl, {
      emails: Array.from(excludedEmails),
      domains: Array.from(excludedDomains),
      companyNames: Array.from(excludedCompanyNames),
    });

    res.json({ leads });
  } catch (error) {
    console.error("Generate leads error:", error.message);
    res.status(500).json({ message: "Failed to generate leads" });
  }
};

const removeLead = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    const { companyName, domain, logoUrl, description, email } = req.body;

    const removedLead = await RemovedLead.findOneAndUpdate(
      { user: req.user._id, email: email.toLowerCase() },
      {
        user: req.user._id,
        companyName,
        domain,
        logoUrl,
        description,
        email: email.toLowerCase(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.status(201).json(removedLead);
  } catch (error) {
    console.error("Remove lead error:", error.message);
    res.status(500).json({ message: "Failed to remove lead" });
  }
};

const getRemovedLeads = async (req, res) => {
  try {
    const { search, sort } = req.query;

    const query = { user: req.user._id };

    if (search) {
      query.$or = [
        { companyName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    let sortOption = { createdAt: -1 };
    if (sort === "name") sortOption = { companyName: 1 };
    if (sort === "oldest") sortOption = { createdAt: 1 };

    const removedLeads = await RemovedLead.find(query).sort(sortOption);
    res.json(removedLeads);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch removed leads" });
  }
};

const restoreRemovedLead = async (req, res) => {
  try {
    const removedLead = await RemovedLead.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!removedLead) {
      return res.status(404).json({ message: "Removed lead not found" });
    }

    res.json({ message: "Lead restored successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to restore removed lead" });
  }
};

const saveLead = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    const { companyName, domain, logoUrl, description, email, source } =
      req.body;

    const lead = await Lead.create({
      user: req.user._id,
      companyName,
      domain,
      logoUrl,
      description,
      email: email.toLowerCase(),
      source: source || "Generated",
    });

    res.status(201).json(lead);
  } catch (error) {
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ message: "This lead has already been saved to your account" });
    }
    console.error("Save lead error:", error.message);
    res.status(500).json({ message: "Failed to save lead" });
  }
};

const getSavedLeads = async (req, res) => {
  try {
    const { status, search, sort } = req.query;

    const query = { user: req.user._id };

    if (status && status !== "All") {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { companyName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    let sortOption = { createdAt: -1 }; // default: newest first
    if (sort === "name") sortOption = { companyName: 1 };
    if (sort === "status") sortOption = { status: 1 };
    if (sort === "oldest") sortOption = { createdAt: 1 };

    const leads = await Lead.find(query).sort(sortOption);
    res.json(leads);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch leads" });
  }
};

const getLeadById = async (req, res) => {
  try {
    const lead = await Lead.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch lead" });
  }
};

const updateLead = async (req, res) => {
  try {
    const lead = await Lead.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    const { status, notes, companyName, email, source } = req.body;

    if (status) lead.status = status;
    if (notes !== undefined) lead.notes = notes;
    if (companyName) lead.companyName = companyName;
    if (email) lead.email = email;
    if (source) lead.source = source;

    const updatedLead = await lead.save();
    res.json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: "Failed to update lead" });
  }
};

const deleteLead = async (req, res) => {
  try {
    const lead = await Lead.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    res.json({ message: "Lead deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete lead" });
  }
};

module.exports = {
  generateLeads,
  saveLead,
  removeLead,
  getSavedLeads,
  getRemovedLeads,
  getLeadById,
  updateLead,
  deleteLead,
  restoreRemovedLead,
  generateValidation,
  saveValidation,
  removeValidation,
};
