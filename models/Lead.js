const mongoose = require("mongoose");

const leadSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    companyName: {
      type: String,
      required: [true, "Company name is required"],
      trim: true,
    },
    domain: {
      type: String,
      trim: true,
    },
    logoUrl: {
      type: String,
    },
    description: {
      type: String,
      default: "",
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,
    },
    source: {
      type: String,
      enum: ["Generated", "Manual", "Referral", "Social Media", "Other"],
      default: "Generated",
    },
    status: {
      type: String,
      enum: ["New", "Contacted", "Qualified", "Converted", "Lost"],
      default: "New",
    },
    notes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

leadSchema.index({ user: 1, email: 1 }, { unique: true });

module.exports = mongoose.model("Lead", leadSchema);
