import request from "supertest";
import app from "../src/index.js";

describe("POST /tasks", () => {
  it("creates a task with a title", async () => {
    const res = await request(app)
      .post("/tasks")
      .send({ title: "Buy milk" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: "Buy milk", done: false });
    expect(res.body.data.id).toBeTypeOf("number");
    expect(res.body.error).toBeNull();
  });

  it("returns 400 when title is missing", async () => {
    const res = await request(app).post("/tasks").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("title is required");
    expect(res.body.data).toBeNull();
  });

  it("auto-increments task id", async () => {
    const res1 = await request(app).post("/tasks").send({ title: "First" });
    const res2 = await request(app).post("/tasks").send({ title: "Second" });
    expect(res2.body.data.id).toBeGreaterThan(res1.body.data.id);
  });
});

describe("GET /tasks", () => {
  it("returns a list of tasks", async () => {
    await request(app).post("/tasks").send({ title: "Task A" });
    await request(app).post("/tasks").send({ title: "Task B" });
    const res = await request(app).get("/tasks");
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    const titles = res.body.data.map((t) => t.title);
    expect(titles).toContain("Task A");
    expect(titles).toContain("Task B");
  });

  it("returns { data, error } format", async () => {
    const res = await request(app).get("/tasks");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("error");
  });
});

describe("PUT /tasks/:id", () => {
  it("updates a task title", async () => {
    const created = await request(app)
      .post("/tasks")
      .send({ title: "Original" });
    const id = created.body.data.id;
    const res = await request(app)
      .put(`/tasks/${id}`)
      .send({ title: "Updated" });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("Updated");
    expect(res.body.error).toBeNull();
  });

  it("updates task done status", async () => {
    const created = await request(app)
      .post("/tasks")
      .send({ title: "Do this" });
    const id = created.body.data.id;
    const res = await request(app)
      .put(`/tasks/${id}`)
      .send({ done: true });
    expect(res.status).toBe(200);
    expect(res.body.data.done).toBe(true);
    expect(res.body.data.title).toBe("Do this");
  });

  it("returns 404 for non-existent task", async () => {
    const res = await request(app)
      .put("/tasks/99999")
      .send({ title: "Nope" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
  });
});

describe("GET /tasks/:id", () => {
  it("returns a single task by id", async () => {
    const created = await request(app)
      .post("/tasks")
      .send({ title: "Find me" });
    const id = created.body.data.id;
    const res = await request(app).get(`/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("Find me");
    expect(res.body.error).toBeNull();
  });

  it("returns 404 for non-existent task", async () => {
    const res = await request(app).get("/tasks/99999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
    expect(res.body.data).toBeNull();
  });
});

describe("GET /tasks/count", () => {
  it("returns the current task count", async () => {
    const before = await request(app).get("/tasks");
    const expectedCount = before.body.data.length;
    const res = await request(app).get("/tasks/count");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(expectedCount);
    expect(res.body.error).toBeNull();
  });

  it("reflects count after adding a task", async () => {
    const before = await request(app).get("/tasks/count");
    const countBefore = before.body.data.count;
    await request(app).post("/tasks").send({ title: "Counted" });
    const after = await request(app).get("/tasks/count");
    expect(after.body.data.count).toBe(countBefore + 1);
  });

  it("returns { data, error } format", async () => {
    const res = await request(app).get("/tasks/count");
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("error");
    expect(res.body.data).toHaveProperty("count");
  });
});

describe("DELETE /tasks", () => {
  it("deletes all tasks and returns the count", async () => {
    await request(app).post("/tasks").send({ title: "One" });
    await request(app).post("/tasks").send({ title: "Two" });
    const before = await request(app).get("/tasks");
    const countBefore = before.body.data.length;

    const res = await request(app).delete("/tasks");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(countBefore);
    expect(res.body.error).toBeNull();

    const after = await request(app).get("/tasks");
    expect(after.body.data.length).toBe(0);
  });

  it("returns deleted: 0 when no tasks exist", async () => {
    await request(app).delete("/tasks");
    const res = await request(app).delete("/tasks");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(0);
    expect(res.body.error).toBeNull();
  });

  it("returns { data, error } format", async () => {
    const res = await request(app).delete("/tasks");
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("error");
    expect(res.body.data).toHaveProperty("deleted");
  });
});

describe("DELETE /tasks/:id", () => {
  it("deletes a task and returns it", async () => {
    const created = await request(app)
      .post("/tasks")
      .send({ title: "Delete me" });
    const id = created.body.data.id;
    const res = await request(app).delete(`/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("Delete me");
    expect(res.body.error).toBeNull();

    const verify = await request(app).get(`/tasks/${id}`);
    expect(verify.status).toBe(404);
  });

  it("returns 404 for non-existent task", async () => {
    const res = await request(app).delete("/tasks/99999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
  });
});

describe("Validation", () => {
  it("rejects title over 100 characters on POST", async () => {
    const longTitle = "a".repeat(101);
    const res = await request(app).post("/tasks").send({ title: longTitle });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("title must be 100 characters or less");
  });

  it("accepts title exactly 100 characters on POST", async () => {
    const title = "a".repeat(100);
    const res = await request(app).post("/tasks").send({ title });
    expect(res.status).toBe(201);
  });

  it("rejects non-string title on POST", async () => {
    const res = await request(app).post("/tasks").send({ title: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("title is required");
  });

  it("rejects title over 100 characters on PUT", async () => {
    const created = await request(app)
      .post("/tasks")
      .send({ title: "Valid" });
    const id = created.body.data.id;
    const longTitle = "a".repeat(101);
    const res = await request(app)
      .put(`/tasks/${id}`)
      .send({ title: longTitle });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("title must be 100 characters or less");
  });
});
