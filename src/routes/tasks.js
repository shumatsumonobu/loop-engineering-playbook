const express = require("express");
const router = express.Router();

const tasks = [];
let nextId = 1;

function validateTitle(title) {
  if (!title || typeof title !== "string") return "title is required";
  if (title.length > 100) return "title must be 100 characters or less";
  return null;
}

router.post("/", (req, res) => {
  try {
    const { title } = req.body;
    const err = validateTitle(title);
    if (err) {
      return res.status(400).json({ data: null, error: err });
    }
    const task = { id: nextId++, title, done: false };
    tasks.push(task);
    res.status(201).json({ data: task, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: "Internal server error" });
  }
});

router.get("/", (req, res) => {
  try {
    res.json({ data: tasks, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: "Internal server error" });
  }
});

router.get("/count", (req, res) => {
  try {
    res.json({ data: { count: tasks.length }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: "Internal server error" });
  }
});

router.delete("/", (req, res) => {
  try {
    const deleted = tasks.length;
    tasks.length = 0;
    res.json({ data: { deleted }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: "Internal server error" });
  }
});

router.put("/:id", (req, res) => {
  try {
    const task = tasks.find((t) => t.id === Number(req.params.id));
    if (!task) {
      return res.status(404).json({ data: null, error: "Task not found" });
    }
    const { title, done } = req.body;
    if (title !== undefined) {
      const err = validateTitle(title);
      if (err) {
        return res.status(400).json({ data: null, error: err });
      }
      task.title = title;
    }
    if (done !== undefined) task.done = done;
    res.json({ data: task, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: "Internal server error" });
  }
});

router.get("/:id", (req, res) => {
  try {
    const task = tasks.find((t) => t.id === Number(req.params.id));
    if (!task) {
      return res.status(404).json({ data: null, error: "Task not found" });
    }
    res.json({ data: task, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: "Internal server error" });
  }
});

router.delete("/:id", (req, res) => {
  try {
    const index = tasks.findIndex((t) => t.id === Number(req.params.id));
    if (index === -1) {
      return res.status(404).json({ data: null, error: "Task not found" });
    }
    const [deleted] = tasks.splice(index, 1);
    res.json({ data: deleted, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: "Internal server error" });
  }
});

module.exports = router;
module.exports._tasks = tasks;
module.exports._resetForTest = () => {
  tasks.length = 0;
  nextId = 1;
};
