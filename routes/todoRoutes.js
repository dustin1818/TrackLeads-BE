const express = require('express');
const router = express.Router();
const {
  getTodos,
  createTodo,
  getTodoById,
  updateTodo,
  deleteTodo,
  todoValidation,
} = require('../controllers/todoController');
const { protect } = require('../middleware/authMiddleware');

router.route('/').get(protect, getTodos).post(protect, todoValidation, createTodo);
router
  .route('/:id')
  .get(protect, getTodoById)
  .put(protect, updateTodo)
  .delete(protect, deleteTodo);

module.exports = router;
