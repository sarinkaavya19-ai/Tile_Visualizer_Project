import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { LayoutStorage } from "../src/services/layout-storage.js";
import { mock } from "node:test";
import { Layout } from "../src/models/layout.js";
import mongoose from "mongoose";

// Mock mongoose connection so migration doesn't exit early in tests
mongoose.connection.readyState = 1;

mock.method(Layout, "findOne", (query) => {
  if (query.id === "kitchen-iridium" || query.id === "room-a") {
    return Promise.resolve({
      toJSON: () => ({
        id: query.id,
        zones: [{ id: "floor", label: "Floor", planes: [{ polygon: [[0, 0], [100, 0], [100, 80], [0, 80]], corners: [[0, 0], [100, 0], [100, 80], [0, 80]] }] }],
        status: "draft"
      })
    });
  }
  return Promise.resolve(null);
});
mock.method(Layout, "findOneAndUpdate", (query, update) => {
  const data = update.$set || update.$setOnInsert;
  return Promise.resolve({ ...data, toJSON: () => data });
});
const layoutDocs = [
  { id: "kitchen-iridium", name: "Kitchen IRIDIUM", type: "photo", roomId: "kitchen", status: "draft", background: null, foreground: null, zones: [{}] },
  { id: "kitchen-onyx", name: "Kitchen ONYX", type: "photo", roomId: "kitchen", status: "published", background: "bg", foreground: "fg", zones: [{}, {}] },
  { id: "kitchen-cloud", name: "Kitchen CLOUD", type: "photo", roomId: "kitchen", status: "published", background: null, foreground: null, zones: [] },
  { id: "living-room", name: "Living", type: "photo", roomId: "living-room", status: "draft", background: null, foreground: null, zones: [] },
];
let lastListFilter = null;
mock.method(Layout, "find", (filter = {}) => {
  lastListFilter = filter;
  const results = layoutDocs.filter((d) => {
    if (filter.roomId && d.roomId !== filter.roomId) return false;
    if (filter.status && d.status !== filter.status) return false;
    return true;
  });
  return { lean: () => Promise.resolve(results) };
});
mock.method(Layout, "create", (doc) => Promise.resolve(doc));

async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tv-test-"));
  return dir;
}

test("create / read / list round-trip", async () => {
  const dir = await tmpDir();
  const storage = new LayoutStorage(dir);
  const room = {
    id: "kitchen-iridium",
    name: "Kitchen IRIDIUM",
    type: "photo",
    background: "/api/layouts/kitchen-iridium/assets/background.png",
    foreground: "/api/layouts/kitchen-iridium/assets/foreground.png",
    zones: [
      { id: "floor", label: "Floor", planes: [{ polygon: [[0, 0], [100, 0], [100, 80], [0, 80]], corners: [[0, 0], [100, 0], [100, 80], [0, 80]] }] },
    ],
    status: "draft",
  };
  await storage.saveConfig(room.id, room);

  const read = await storage.readConfig(room.id);
  assert.equal(read.id, "kitchen-iridium");
  assert.equal(read.zones[0].planes[0].polygon[1][0], 100);

  const list = await storage.listLayouts();
  const found = list.find((l) => l.id === "kitchen-iridium");
  assert.ok(found, "layout listed");
  assert.equal(found.status, "draft");
  assert.equal(found.zoneCount, 1);
});

test("listLayouts forwards roomId and status filters into the query", async () => {
  const dir = await tmpDir();
  const storage = new LayoutStorage(dir);

  const published = await storage.listLayouts({ roomId: "kitchen", status: "published" });
  assert.deepEqual(lastListFilter, { roomId: "kitchen", status: "published" });
  assert.equal(published.length, 2);
  assert.ok(published.every((l) => l.roomId === "kitchen" && l.status === "published"));
  assert.equal(published[0].id, "kitchen-onyx");
  assert.equal(published[0].hasBackground, true);
  assert.equal(published[0].zoneCount, 2);

  const none = await storage.listLayouts({ roomId: "bathroom", status: "published" });
  assert.equal(none.length, 0);
});

test("concurrent migrations complete without failure", async () => {
  const dir = await tmpDir();
  // Create a dummy legacy layout
  const roomDir = path.join(dir, "legacy-room");
  await fs.mkdir(roomDir, { recursive: true });
  await fs.writeFile(path.join(roomDir, "config.json"), JSON.stringify({
    name: "Legacy", type: "photo", status: "draft", zones: []
  }));

  const storage1 = new LayoutStorage(dir);
  const storage2 = new LayoutStorage(dir);
  
  // Start migrations concurrently across different instances (simulating processes)
  await Promise.all([
    storage1._migrateLegacyLayouts(),
    storage2._migrateLegacyLayouts()
  ]);

  assert.equal(storage1._migrated, true);
  assert.equal(storage2._migrated, true);
});

test("asset write/read and traversal guard", async () => {
  const dir = await tmpDir();
  const storage = new LayoutStorage(dir);
  await storage.ensureLayout("room-a");
  await storage.writeAssetBuffer("room-a", "background", Buffer.from("FAKE"), "bg.png");
  await storage.writeAssetBuffer("room-a", "foreground", Buffer.from("FAKE"), "fg.png");

  assert.equal(storage.assetUrl("room-a", "background.png"), "/api/layouts/room-a/assets/background.png");
  assert.throws(() => storage.resolveAssetPath("room-a", "../evil.png"), /Invalid/);
  assert.throws(() => storage.resolveAssetPath("room-a", "a/b/c/d/x.png"), /Unsupported/);
});

test("rasterizeMask produces a valid PNG of the requested size", async () => {
  const dir = await tmpDir();
  const storage = new LayoutStorage(dir);
  const url = await storage.rasterizeMask("k", "floor", {
    polygon: [[10, 10], [170, 10], [170, 80], [10, 80]],
    corners: null,
    width: 200,
    height: 100,
  });
  assert.equal(url, "/api/layouts/k/assets/masks/floor.png");
  const buf = await storage.readAssetBuffer("k", "masks/floor.png");
  const meta = await sharp(buf).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 100);
  assert.equal(meta.channels, 4);
});

test("invalid room id is rejected", async (t) => {
  const dir = await tmpDir();
  const storage = new LayoutStorage(dir);
  await assert.rejects(() => storage.saveConfig("../etc", {}), /Invalid room id/);
});

test("validateLayout rejects bad configs", async () => {
  const { validateLayout } = await import("@tile-visualizer/shared/schemas/layout.js");
  const { ok, errors } = validateLayout({ id: "", name: "x", type: "nope", status: "live", zones: [] });
  assert.equal(ok, false);
  assert.ok(errors.length > 0);
});
