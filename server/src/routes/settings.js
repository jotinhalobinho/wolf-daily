"use strict";

const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/settings
router.get("/", (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'workingDays'").get();
  res.json({ workingDays: row ? Number(row.value) : 22 });
});

// PUT /api/settings  { workingDays }
router.put("/", requireAdmin, (req, res) => {
  const workingDays = Number(req.body && req.body.workingDays);
  if (!(workingDays > 0 && workingDays <= 31)) return res.status(400).json({ error: "Valor inválido" });
  db.prepare("INSERT INTO settings (key, value) VALUES ('workingDays', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(workingDays)
  );
  res.json({ workingDays });
});

module.exports = router;
