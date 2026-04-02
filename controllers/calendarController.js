const { body, validationResult } = require("express-validator");
const CalendarEvent = require("../models/CalendarEvent");
const Todo = require("../models/Todo");

// Validation rules
const eventValidation = [
  body("title").trim().notEmpty().withMessage("Title is required"),
  body("startDate").isISO8601().withMessage("Valid start date is required"),
];

const getEvents = async (req, res) => {
  try {
    const { month, year } = req.query;
    const query = { user: req.user._id };

    if (month && year) {
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);
      query.startDate = { $gte: startOfMonth, $lte: endOfMonth };
    }

    const events = await CalendarEvent.find(query)
      .populate("linkedTodo")
      .sort({ startDate: 1 });

    res.json(events);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch events" });
  }
};

const createEvent = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    const { title, description, startDate, endDate, color, linkedTodo } =
      req.body;

    const event = await CalendarEvent.create({
      user: req.user._id,
      title,
      description,
      startDate,
      endDate,
      color,
      linkedTodo,
    });

    if (linkedTodo) {
      await Todo.findOneAndUpdate(
        { _id: linkedTodo, user: req.user._id },
        { calendarEvent: event._id },
      );
    }

    res.status(201).json(event);
  } catch (error) {
    res.status(500).json({ message: "Failed to create event" });
  }
};

const getEventById = async (req, res) => {
  try {
    const event = await CalendarEvent.findOne({
      _id: req.params.id,
      user: req.user._id,
    }).populate("linkedTodo");

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json(event);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch event" });
  }
};

const updateEvent = async (req, res) => {
  try {
    const event = await CalendarEvent.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const { title, description, startDate, endDate, color, linkedTodo } =
      req.body;

    if (title !== undefined) event.title = title;
    if (description !== undefined) event.description = description;
    if (startDate !== undefined) event.startDate = startDate;
    if (endDate !== undefined) event.endDate = endDate;
    if (color !== undefined) event.color = color;
    if (linkedTodo !== undefined) event.linkedTodo = linkedTodo;

    const updatedEvent = await event.save();
    res.json(updatedEvent);
  } catch (error) {
    res.status(500).json({ message: "Failed to update event" });
  }
};

const deleteEvent = async (req, res) => {
  try {
    const event = await CalendarEvent.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    if (event.linkedTodo) {
      await Todo.findByIdAndUpdate(event.linkedTodo, {
        $unset: { calendarEvent: 1 },
      });
    }

    res.json({ message: "Event deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete event" });
  }
};

module.exports = {
  getEvents,
  createEvent,
  getEventById,
  updateEvent,
  deleteEvent,
  eventValidation,
};
