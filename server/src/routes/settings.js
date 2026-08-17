"use strict";

const express = require("express");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/settings
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const row = await db.get("SELECT value FROM settings WHERE `key` = 'workingDays'");
    res.json({ workingDays: row ? Number(row.value) : 22 });
  })
);

// PUT /api/settings  { workingDays }
router.put(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workingDays = Number(req.body && req.body.workingDays);
    if (!(workingDays > 0 && workingDays <= 31)) return res.status(400).json({ error: "Valor inválido" });
    await db.run(
      "INSERT INTO settings (`key`, value) VALUES ('workingDays', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [String(workingDays)]
    );
    res.json({ workingDays });
  })
);

module.exports = router;
