import request from "supertest";
import app from "../src/index.js";
import pkg from "../package.json";

describe("GET /health", () => {
  it("returns status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /health/version", () => {
  it("returns the version from package.json", async () => {
    const res = await request(app).get("/health/version");
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(pkg.version);
    expect(res.body.error).toBeNull();
  });

  it("returns { data, error } format", async () => {
    const res = await request(app).get("/health/version");
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("error");
    expect(res.body.data).toHaveProperty("version");
  });

  it("version is a valid semver string", async () => {
    const res = await request(app).get("/health/version");
    expect(res.body.data.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
