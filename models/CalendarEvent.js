const mongoose = require('mongoose');

const calendarEventSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    startDate: {
      type: Date,
      required: [true, 'Start date is required'],
    },
    endDate: {
      type: Date,
    },
    color: {
      type: String,
      default: '#3CB89A',
    },
    linkedTodo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Todo',
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('CalendarEvent', calendarEventSchema);
