const express = require("express");
const app = express();

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/health/version", (req, res) => {
  try {
    const { version } = require("../package.json");
    res.json({ data: { version }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: "Failed to read version" });
  }
});

const tasksRouter = require("./routes/tasks");
app.use("/tasks", tasksRouter);

const PORT = process.env.PORT || 3001;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
