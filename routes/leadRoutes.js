const express = require("express");
const router = express.Router();
const {
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
} = require("../controllers/leadController");
const { protect } = require("../middleware/authMiddleware");

router.post("/generate", protect, generateValidation, generateLeads);
router.post("/save", protect, saveValidation, saveLead);
router.post("/remove", protect, removeValidation, removeLead);
router.get("/removed", protect, getRemovedLeads);
router.delete("/removed/:id", protect, restoreRemovedLead);
router.get("/", protect, getSavedLeads);
router
  .route("/:id")
  .get(protect, getLeadById)
  .put(protect, updateLead)
  .delete(protect, deleteLead);

module.exports = router;
