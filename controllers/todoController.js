const { body, validationResult } = require("express-validator");
const Todo = require("../models/Todo");

// Validation rules
const todoValidation = [
  body("title").trim().notEmpty().withMessage("Title is required"),
];

const getTodos = async (req, res) => {
  try {
    const { status, priority } = req.query;
    const query = { user: req.user._id };

    if (status === "active") query.isCompleted = false;
    if (status === "completed") query.isCompleted = true;
    if (priority && priority !== "All") query.priority = priority;

    const todos = await Todo.find(query)
      .populate("calendarEvent")
      .sort({ createdAt: -1 });

    res.json(todos);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch todos" });
  }
};

const createTodo = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    const { title, description, priority, dueDate, calendarEvent } = req.body;

    const todo = await Todo.create({
      user: req.user._id,
      title,
      description,
      priority,
      dueDate,
      calendarEvent,
    });

    res.status(201).json(todo);
  } catch (error) {
    res.status(500).json({ message: "Failed to create todo" });
  }
};

const getTodoById = async (req, res) => {
  try {
    const todo = await Todo.findOne({
      _id: req.params.id,
      user: req.user._id,
    }).populate("calendarEvent");

    if (!todo) {
      return res.status(404).json({ message: "Todo not found" });
    }

    res.json(todo);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch todo" });
  }
};

const updateTodo = async (req, res) => {
  try {
    const todo = await Todo.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!todo) {
      return res.status(404).json({ message: "Todo not found" });
    }

    const {
      title,
      description,
      priority,
      isCompleted,
      dueDate,
      calendarEvent,
    } = req.body;

    if (title !== undefined) todo.title = title;
    if (description !== undefined) todo.description = description;
    if (priority !== undefined) todo.priority = priority;
    if (isCompleted !== undefined) todo.isCompleted = isCompleted;
    if (dueDate !== undefined) todo.dueDate = dueDate;
    if (calendarEvent !== undefined) todo.calendarEvent = calendarEvent;

    const updatedTodo = await todo.save();
    res.json(updatedTodo);
  } catch (error) {
    res.status(500).json({ message: "Failed to update todo" });
  }
};

const deleteTodo = async (req, res) => {
  try {
    const todo = await Todo.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!todo) {
      return res.status(404).json({ message: "Todo not found" });
    }

    res.json({ message: "Todo deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete todo" });
  }
};

module.exports = {
  getTodos,
  createTodo,
  getTodoById,
  updateTodo,
  deleteTodo,
  todoValidation,
};
