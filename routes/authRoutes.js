const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  getMe,
  updateMe,
  registerValidation,
  loginValidation,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', registerValidation, registerUser);
router.post('/login', loginValidation, loginUser);
router.route('/me').get(protect, getMe).put(protect, updateMe);

module.exports = router;
