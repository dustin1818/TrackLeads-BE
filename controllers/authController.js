const { validationResult, body } = require("express-validator");
const PendingRegistration = require("../models/PendingRegistration");
const User = require("../models/User");
const generateToken = require("../utils/generateToken");
const { sendVerificationOtpEmail } = require("../services/emailService");

const PASSWORD_MIN_LENGTH = 8;
const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = User.OTP_EXPIRY_MINUTES || 10;

// Validation rules
const registerValidation = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("email").isEmail().withMessage("Please provide a valid email"),
  body("password")
    .isLength({ min: PASSWORD_MIN_LENGTH })
    .withMessage(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`),
];

const loginValidation = [
  body("email").isEmail().withMessage("Please provide a valid email"),
  body("password").notEmpty().withMessage("Password is required"),
];

const verifyOtpValidation = [
  body("email").isEmail().withMessage("Please provide a valid email"),
  body("otp")
    .isLength({ min: OTP_LENGTH, max: OTP_LENGTH })
    .withMessage("OTP must be 6 digits")
    .isNumeric()
    .withMessage("OTP must be 6 digits"),
];

const resendOtpValidation = [
  body("email").isEmail().withMessage("Please provide a valid email"),
];

const updateValidation = [
  body("name").optional().trim().notEmpty().withMessage("Name is required"),
  body("email")
    .optional()
    .isEmail()
    .withMessage("Please provide a valid email"),
  body("password")
    .optional()
    .isLength({ min: PASSWORD_MIN_LENGTH })
    .withMessage(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`),
];

const getRequestValidationMessage = (req) => {
  const errors = validationResult(req);
  return errors.isEmpty() ? null : errors.array()[0].msg;
};

const getPersistenceValidationMessage = (error) => {
  if (error.code === 11000) {
    return "Email already in use";
  }

  if (error.name === "ValidationError") {
    return Object.values(error.errors)[0].message;
  }

  return null;
};

const generateOtpCode = () =>
  String(Math.floor(Math.random() * 10 ** OTP_LENGTH)).padStart(
    OTP_LENGTH,
    "0",
  );

const buildOtpExpiry = () =>
  new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

const sanitizeUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  avatar: user.avatar,
  isVerified: user.isVerified,
  createdAt: user.createdAt,
});

const buildOtpResponse = (email, previewUrl, message) => ({
  message,
  email,
  deliveryMode: previewUrl ? "preview" : "resend",
  ...(previewUrl ? { previewUrl } : {}),
});

const setOtpOnRecord = (record) => {
  record.verificationOtp = generateOtpCode();
  record.verificationOtpExpiresAt = buildOtpExpiry();
};

const sendOtpForRecord = async (record) => {
  setOtpOnRecord(record);
  await record.save();

  return sendVerificationOtpEmail({
    email: record.email,
    name: record.name,
    otp: record.verificationOtp,
    expiresInMinutes: OTP_EXPIRY_MINUTES,
  });
};

const sendPersistenceOrServerError = (res, error) => {
  const validationMessage = getPersistenceValidationMessage(error);
  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  console.error("Server error:", error);
  return res
    .status(500)
    .json({ message: "Server error", debug: error.message });
};

const getOtpValidationError = (user, otp) => {
  if (!user.verificationOtp || !user.verificationOtpExpiresAt) {
    return "Verification code is not available. Please resend it";
  }

  if (user.verificationOtpExpiresAt.getTime() < Date.now()) {
    return "Verification code has expired. Please resend it";
  }

  if (user.verificationOtp !== otp) {
    return "Invalid verification code";
  }

  return null;
};

const createOrUpdatePendingRegistration = async ({ name, email, password }) => {
  const pendingRegistration =
    (await PendingRegistration.findOne({ email }).select(
      "+password +verificationOtp +verificationOtpExpiresAt",
    )) || new PendingRegistration({ email });

  pendingRegistration.name = name;
  pendingRegistration.email = email;
  pendingRegistration.password = password;

  return pendingRegistration;
};

const migrateLegacyUnverifiedUser = async (email) => {
  const legacyUser = await User.findOne({ email, isVerified: false }).select(
    "+password +verificationOtp +verificationOtpExpiresAt",
  );

  if (!legacyUser) {
    return null;
  }

  const pendingRegistration =
    (await PendingRegistration.findOne({ email }).select(
      "+password +verificationOtp +verificationOtpExpiresAt",
    )) || new PendingRegistration({ email });

  pendingRegistration.name = legacyUser.name;
  pendingRegistration.email = legacyUser.email;
  pendingRegistration.password = legacyUser.password;
  pendingRegistration.verificationOtp = legacyUser.verificationOtp;
  pendingRegistration.verificationOtpExpiresAt =
    legacyUser.verificationOtpExpiresAt;
  pendingRegistration.$locals = {
    ...(pendingRegistration.$locals || {}),
    skipPasswordHash: true,
  };

  await pendingRegistration.save();
  await User.deleteOne({ _id: legacyUser._id });

  return pendingRegistration;
};

const getPendingRegistration = async (email) => {
  const pendingRegistration = await PendingRegistration.findOne({
    email,
  }).select("+password +verificationOtp +verificationOtpExpiresAt");

  return pendingRegistration || migrateLegacyUnverifiedUser(email);
};

const createVerifiedUserFromPending = async (pendingRegistration) => {
  const user = new User({
    name: pendingRegistration.name,
    email: pendingRegistration.email,
    password: pendingRegistration.password,
    isVerified: true,
  });

  user.$locals = {
    ...(user.$locals || {}),
    skipPasswordHash: true,
  };

  await user.save();
  await PendingRegistration.deleteOne({ _id: pendingRegistration._id });

  return user;
};

const applyUserProfileUpdates = (user, payload) => {
  user.name = payload.name || user.name;
  user.email = payload.email || user.email;
  user.avatar = payload.avatar !== undefined ? payload.avatar : user.avatar;

  if (payload.password) {
    user.password = payload.password;
  }
};

const registerUser = async (req, res) => {
  const validationMessage = getRequestValidationMessage(req);
  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  const { name, email, password } = req.body;

  try {
    const userExists = await User.findOne({ email, isVerified: true });
    if (userExists) {
      return res.status(400).json({ message: "User already exists" });
    }

    await migrateLegacyUnverifiedUser(email);

    const pendingRegistration = await createOrUpdatePendingRegistration({
      name,
      email,
      password,
    });
    const previewUrl = await sendOtpForRecord(pendingRegistration);

    res
      .status(201)
      .json(
        buildOtpResponse(
          email,
          previewUrl,
          "Verification code sent to your email",
        ),
      );
  } catch (error) {
    return sendPersistenceOrServerError(res, error);
  }
};

const loginUser = async (req, res) => {
  const validationMessage = getRequestValidationMessage(req);
  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  const { email, password } = req.body;

  try {
    // Find user and include password for comparison
    const user = await User.findOne({ email }).select("+password");

    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (!user.isVerified) {
      return res
        .status(403)
        .json({ message: "Verify your email before logging in" });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    res.json({
      ...sanitizeUser(user),
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

const verifyOtp = async (req, res) => {
  const validationMessage = getRequestValidationMessage(req);
  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  const { email, otp } = req.body;

  try {
    const verifiedUser = await User.findOne({ email, isVerified: true });
    if (verifiedUser) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    const pendingRegistration = await getPendingRegistration(email);

    if (!pendingRegistration) {
      return res
        .status(404)
        .json({ message: "Pending registration not found" });
    }

    const otpValidationMessage = getOtpValidationError(
      pendingRegistration,
      otp,
    );
    if (otpValidationMessage) {
      return res.status(400).json({ message: otpValidationMessage });
    }

    const user = await createVerifiedUserFromPending(pendingRegistration);

    res.json({
      message: "Email verified successfully",
      user: sanitizeUser(user),
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

const resendOtp = async (req, res) => {
  const validationMessage = getRequestValidationMessage(req);
  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  const { email } = req.body;

  try {
    const verifiedUser = await User.findOne({ email, isVerified: true });
    if (verifiedUser) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    const pendingRegistration = await getPendingRegistration(email);

    if (!pendingRegistration) {
      return res
        .status(404)
        .json({ message: "Pending registration not found" });
    }

    const previewUrl = await sendOtpForRecord(pendingRegistration);

    res.json(
      buildOtpResponse(
        email,
        previewUrl,
        "A new verification code has been sent",
      ),
    );
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

const getMe = async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json(sanitizeUser(user));
};

const updateMe = async (req, res) => {
  const validationMessage = getRequestValidationMessage(req);
  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  try {
    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    applyUserProfileUpdates(user, req.body);

    const updatedUser = await user.save();

    res.json(sanitizeUser(updatedUser));
  } catch (error) {
    return sendPersistenceOrServerError(res, error);
  }
};

module.exports = {
  registerUser,
  loginUser,
  verifyOtp,
  resendOtp,
  getMe,
  updateMe,
  registerValidation,
  loginValidation,
  verifyOtpValidation,
  resendOtpValidation,
  updateValidation,
};
