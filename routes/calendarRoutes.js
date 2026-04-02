const express = require('express');
const router = express.Router();
const {
  getEvents,
  createEvent,
  getEventById,
  updateEvent,
  deleteEvent,
  eventValidation,
} = require('../controllers/calendarController');
const { protect } = require('../middleware/authMiddleware');

router.route('/').get(protect, getEvents).post(protect, eventValidation, createEvent);
router
  .route('/:id')
  .get(protect, getEventById)
  .put(protect, updateEvent)
  .delete(protect, deleteEvent);

module.exports = router;
