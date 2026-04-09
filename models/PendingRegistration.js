const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const PENDING_REGISTRATION_TTL_SECONDS = 60 * 60 * 24;

const pendingRegistrationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please add a name"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Please add an email"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please add a valid email"],
    },
    password: {
      type: String,
      required: [true, "Please add a password"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },
    verificationOtp: {
      type: String,
      select: false,
    },
    verificationOtpExpiresAt: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

pendingRegistrationSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: PENDING_REGISTRATION_TTL_SECONDS },
);

pendingRegistrationSchema.pre("save", async function (next) {
  if (this.$locals?.skipPasswordHash || !this.isModified("password")) {
    return next();
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

module.exports = mongoose.model(
  "PendingRegistration",
  pendingRegistrationSchema,
);
