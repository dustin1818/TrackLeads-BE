const mongoose = require("mongoose");

const removedLeadSchema = new mongoose.Schema(
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
  },
  {
    timestamps: true,
  },
);

removedLeadSchema.index({ user: 1, email: 1 }, { unique: true });

module.exports = mongoose.model("RemovedLead", removedLeadSchema);
