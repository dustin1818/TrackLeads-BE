const express = require("express");
const router = express.Router();
const {
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
} = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

router.post("/register", registerValidation, registerUser);
router.post("/login", loginValidation, loginUser);
router.post("/verify-otp", verifyOtpValidation, verifyOtp);
router.post("/resend-otp", resendOtpValidation, resendOtp);
router
  .route("/me")
  .get(protect, getMe)
  .put(protect, updateValidation, updateMe);

module.exports = router;
